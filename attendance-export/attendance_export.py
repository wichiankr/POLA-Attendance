"""Read-only Sheets attendance exporter. No production connections on import."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import date, datetime, timedelta
import errno
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import posixpath
import re
import stat
import sys
import tempfile
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Bangkok")
LOG = logging.getLogger("attendance_export")
SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"


def employee_id(value):
    if isinstance(value, bool):
        raise ValueError("EmployeeId must be 1–4 digits")
    if isinstance(value, (int, float)) and math.isfinite(value) and int(value) == value:
        value = str(int(value))
    value = str(value).strip()
    if not re.fullmatch(r"[0-9]{1,4}", value):
        raise ValueError("EmployeeId must be 1–4 digits")
    return value.zfill(4)


def timestamp(value):
    if isinstance(value, bool):
        raise ValueError("invalid timestamp")
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value < 1:
            raise ValueError("invalid Sheets date serial")
        result = datetime(1899, 12, 30) + timedelta(seconds=round(value * 86400))
    else:
        text = str(value).strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?", text):
            raise ValueError("timestamp must be ISO yyyy-MM-dd HH:mm:ss or a Sheets serial")
        result = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return result.replace(tzinfo=TZ) if result.tzinfo is None else result.astimezone(TZ)


def records(values, sheet, required):
    if not values:
        raise ValueError(f"{sheet}: missing header row")
    headers = [str(v).strip() for v in values[0]]
    if len(headers) != len(set(headers)):
        raise ValueError(f"{sheet}: duplicate headers")
    missing = set(required) - set(headers)
    if missing:
        raise ValueError(f"{sheet}: missing headers {', '.join(sorted(missing))}")
    for number, row in enumerate(values[1:], 2):
        if not any(str(v).strip() for v in row):
            continue
        yield number, {header: row[i] if i < len(row) else "" for i, header in enumerate(headers)}


def export_bytes(tables, start, end, cutoff):
    """Validate source rows before returning any output; group by actual local timestamp."""
    employees = {}
    for row_number, row in records(tables["Employees"], "Employees", ["Email", "EmployeeId"]):
        email = str(row["Email"]).strip().lower()
        if email:
            employees.setdefault(email, []).append((row_number, row["EmployeeId"]))
    groups = {}
    for sheet, fields in (("Punches", ["PunchTime"]), ("Attendance", ["ClockIn", "ClockOut"])):
        for row_number, row in records(tables[sheet], sheet, ["Email", *fields]):
            try:
                times = [timestamp(row[field]) for field in fields if str(row[field]).strip()]
                if not times:
                    raise ValueError("missing attendance timestamp")
                times = [t for t in times if start <= t.date() <= end and t <= cutoff]
                if not times:
                    continue
                raw_id = row.get("EmployeeId", "")
                if not str(raw_id).strip():
                    matches = employees.get(str(row["Email"]).strip().lower(), [])
                    if len(matches) != 1:
                        raise ValueError("EmployeeId missing and Employees email match is missing or ambiguous")
                    raw_id = matches[0][1]
                emp_id = employee_id(raw_id)
                for time in times:
                    groups.setdefault((emp_id, time.date()), []).append(time)
            except (ValueError, OverflowError, TypeError) as exc:
                raise ValueError(f"{sheet} row {row_number}: {exc}") from exc
    selected = set()
    for (emp_id, _), times in groups.items():
        for time in (min(times), max(times)):
            selected.add((time.replace(second=0, microsecond=0), emp_id))
    return "".join(f"{emp_id}  {time:%d-%m-%Y}  {time:%H:%M}  1  I  1\r\n"
                   for time, emp_id in sorted(selected)).encode("ascii")


def read_sheets(spreadsheet_id, credentials_path):
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build

    credentials = Credentials.from_service_account_file(credentials_path, scopes=[SCOPE])
    with build("sheets", "v4", credentials=credentials, cache_discovery=False) as api:
        # Metadata permits the optional legacy/new sheet to be absent without masking a typo
        # in the required Employees tab. Values are never parsed using display locale.
        metadata = api.spreadsheets().get(spreadsheetId=spreadsheet_id,
                                         fields="sheets.properties.title").execute()
        names = {s["properties"]["title"] for s in metadata["sheets"]}
        if "Employees" not in names or not names.intersection({"Punches", "Attendance"}):
            raise ValueError("Spreadsheet requires Employees and at least one attendance sheet")
        selected = [s for s in ("Employees", "Punches", "Attendance") if s in names]
        response = api.spreadsheets().values().batchGet(
            spreadsheetId=spreadsheet_id, ranges=[f"'{s}'!A:Z" for s in selected],
            valueRenderOption="UNFORMATTED_VALUE", dateTimeRenderOption="SERIAL_NUMBER",
        ).execute()
    tables = {s: item.get("values", []) for s, item in zip(selected, response["valueRanges"])}
    for sheet, header in (("Punches", ["Email", "EmployeeId", "PunchTime"]),
                          ("Attendance", ["Email", "EmployeeId", "ClockIn", "ClockOut"])):
        tables.setdefault(sheet, [header])
    return tables


@contextmanager
def job_lock(path):
    """OS advisory lock released even after a process crash; shared by all job modes."""
    handle = open(path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            if handle.seek(0, 2) == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RuntimeError("another attendance export is running") from None
    try:
        yield
    finally:
        handle.close()


def required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"missing environment setting: {name}")
    return value


def load_sftp_config():
    with open(required_env("SFTP_CONFIG_FILE"), encoding="utf-8") as handle:
        config = json.load(handle)
    for name in ("host", "username", "password"):
        if not isinstance(config.get(name), str) or not config[name]:
            raise ValueError(f"SFTP config requires {name}")
    config.setdefault("port", 22)
    config.setdefault("destination", "POLA/Inbound/TM")
    if config.get("host_key_policy", "strict") not in ("strict", "tofu"):
        raise ValueError("host_key_policy must be strict or tofu")
    return config


def remember_first_key(client, hostname, key, filename):
    import paramiko

    filename = Path(filename)
    with job_lock(filename.with_name(filename.name + ".lock")):
        keys = paramiko.HostKeys()
        if filename.exists():
            keys.load(str(filename))
        previous = keys.lookup(hostname)
        if previous is not None:
            if not keys.check(hostname, key):
                raise paramiko.SSHException("Pinned host key changed; refusing connection")
        else:
            keys.add(hostname, key.get_name(), key)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=filename.parent, delete=False) as handle:
                    temporary = Path(handle.name)
                keys.save(str(temporary))
                with temporary.open("r+b") as handle:
                    os.fsync(handle.fileno())
                temporary.replace(filename)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            fingerprint = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
            LOG.warning("TOFU: saved first host key SHA256:%s to %s; future changes will be rejected",
                        fingerprint, filename)
        client.get_host_keys().add(hostname, key.get_name(), key)


def host_key_file(config, data_dir):
    if config.get("host_key_policy", "strict") == "tofu":
        return data_dir / "sftp_known_hosts"
    return Path(required_env("SFTP_KNOWN_HOSTS"))


@contextmanager
def sftp_connection(config, known_hosts):
    import paramiko

    policy = config.get("host_key_policy", "strict")
    if policy not in ("strict", "tofu"):
        raise ValueError("host_key_policy must be strict or tofu")
    with paramiko.SSHClient() as client:
        if policy == "tofu":
            if Path(known_hosts).exists():
                client.load_host_keys(str(known_hosts))

            class RememberFirstKey(paramiko.MissingHostKeyPolicy):
                def missing_host_key(self, ssh_client, hostname, key):
                    remember_first_key(ssh_client, hostname, key, known_hosts)

            client.set_missing_host_key_policy(RememberFirstKey())
        else:
            client.load_host_keys(str(known_hosts))
            client.set_missing_host_key_policy(paramiko.RejectPolicy())
        client.connect(config["host"], port=int(config.get("port", 22)),
                       username=config["username"], password=config["password"],
                       look_for_keys=False, allow_agent=False, timeout=30,
                       auth_timeout=30, banner_timeout=30)
        with client.open_sftp() as sftp:
            sftp.get_channel().settimeout(60)
            yield sftp


def upload(path, config, known_hosts):
    remote = posixpath.join(config["destination"], path.name)
    with sftp_connection(config, known_hosts) as sftp:
        try:
            sftp.lstat(remote)
        except OSError as exc:
            if exc.errno != errno.ENOENT:
                raise
        else:
            raise FileExistsError("SFTP destination filename already exists")
        # Exclusive creation closes the race between existence checking and upload.
        # A failed transfer may leave a partial file: never retry it automatically.
        with path.open("rb") as source, sftp.open(remote, "wx") as destination:
            while chunk := source.read(32768):
                destination.write(chunk)
        if sftp.stat(remote).st_size != path.stat().st_size:
            raise IOError("SFTP uploaded size does not match local file")


def run(args):
    cutoff = datetime.now(TZ)
    if (args.start_date is None) != (args.end_date is None):
        raise ValueError("--start-date and --end-date must be provided together")
    start = args.start_date or cutoff.date() - timedelta(days=6)
    end = args.end_date or cutoff.date()
    if start > end:
        raise ValueError("start date must not be after end date")
    data_dir = Path(os.environ.get("DATA_DIR", "/data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    with job_lock(data_dir / ".export.lock"):
        if getattr(args, "check_sftp", False):
            config = load_sftp_config()
            with sftp_connection(config, host_key_file(config, data_dir)) as sftp:
                if not stat.S_ISDIR(sftp.stat(config["destination"]).st_mode or 0):
                    raise ValueError("SFTP destination is not a directory")
            LOG.info("SFTP authentication and destination directory check passed; no files uploaded")
            return
        tables = read_sheets(required_env("SPREADSHEET_ID"), required_env("GOOGLE_APPLICATION_CREDENTIALS"))
        payload = export_bytes(tables, start, end, cutoff)
        if not payload:
            LOG.info("No attendance records for %s through %s; skipped", start, end)
            return
        filename = f"{cutoff:%Y%m%d}{cutoff.hour}{cutoff:%M%S}.txt"
        folder = data_dir / ("dry-run" if args.dry_run else "pending")
        folder.mkdir(exist_ok=True)
        archive = data_dir / "uploaded"
        archive.mkdir(exist_ok=True)
        if (archive / filename).exists():
            raise FileExistsError("local archive filename already exists")
        path = folder / filename
        with path.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        LOG.info("Created %s: %d records, %d bytes; dates %s through %s", path,
                 payload.count(b"\r\n"), len(payload), start, end)
        if args.dry_run:
            LOG.info("Dry run completed; no SFTP connection")
            return
        try:
            config = load_sftp_config()
            upload(path, config, host_key_file(config, data_dir))
        except Exception:
            LOG.error("Upload not confirmed; retained %s. Inspect remote before any manual resend.", path)
            raise
        path.rename(archive / filename)
        LOG.info("Upload confirmed; archived %s", filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--check-sftp", action="store_true", help="Check login and destination without uploading; TOFU may save first host key")
    parser.add_argument("--start-date", type=date.fromisoformat)
    parser.add_argument("--end-date", type=date.fromisoformat)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        run(args)
    except Exception as exc:
        # Do not log third-party exception messages: HTTP/SSH errors can contain secrets.
        if isinstance(exc, (ValueError, RuntimeError, FileExistsError)):
            LOG.error("Export failed: %s", exc)
        else:
            LOG.error("Export failed (%s); check connectivity, credentials and pending files", type(exc).__name__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
