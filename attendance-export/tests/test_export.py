from datetime import date, datetime
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import paramiko

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import attendance_export as app


def tables(punches=(), attendance=(), employees=()):
    return {
        "Employees": [["Email", "EmployeeId", "Active"], *employees],
        "Punches": [["Email", "EmployeeId", "PunchTime"], *punches],
        "Attendance": [["Email", "EmployeeId", "ClockIn", "ClockOut"], *attendance],
    }


class ExportTests(unittest.TestCase):
    cutoff = datetime(2026, 11, 4, 23, tzinfo=app.TZ)

    def render(self, source):
        return app.export_bytes(source, date(2026, 10, 29), date(2026, 11, 4), self.cutoff)

    def test_exact_bytes_and_min_max_combined(self):
        source = tables(punches=[
            ["a@pola", "0019", "2026-11-04 08:30:09"],
            ["a@pola", "0019", "2026-11-04 12:00:00"],
            ["a@pola", "0019", "2026-11-04 17:30:59"],
        ], attendance=[["a@pola", 19, "2026-11-04 08:35:00", "2026-11-04 16:00:00"]])
        self.assertEqual(self.render(source),
                         b"0019  04-11-2026  08:30  1  I  1\r\n"
                         b"0019  04-11-2026  17:30  1  I  1\r\n")

    def test_seven_calendar_days_cutoff_and_sorting(self):
        source = tables(punches=[
            ["a", 19, "2026-10-28 23:59:59"],
            ["a", 19, "2026-10-29 00:00:00"],
            ["b", 24, "2026-11-04 08:30:00"],
            ["a", 19, "2026-11-04 08:30:00"],
            ["a", 19, "2026-11-04 23:00:01"],
            ["a", 19, "2026-11-05 00:00:00"],
        ])
        self.assertEqual(self.render(source),
                         b"0019  29-10-2026  00:00  1  I  1\r\n"
                         b"0019  04-11-2026  08:30  1  I  1\r\n"
                         b"0024  04-11-2026  08:30  1  I  1\r\n")

    def test_one_punch_and_same_minute(self):
        source = tables(punches=[["a", 19, "2026-11-04 08:30:01"],
                                ["a", 19, "2026-11-04 08:30:59"]])
        self.assertEqual(self.render(source).count(b"\r\n"), 1)

    def test_serial_and_inactive_employee_fallback(self):
        serial = (datetime(2026, 11, 4, 8, 30) - datetime(1899, 12, 30)).total_seconds() / 86400
        source = tables(attendance=[["A@pola", "", serial, ""]], employees=[["a@pola", 97, False]])
        self.assertEqual(self.render(source), b"0097  04-11-2026  08:30  1  I  1\r\n")

    def test_midnight_uses_timestamp_not_workdate(self):
        source = tables(attendance=[["a", 19, "2026-11-03 23:59:00", "2026-11-04 00:01:00"]])
        self.assertEqual(self.render(source),
                         b"0019  03-11-2026  23:59  1  I  1\r\n"
                         b"0019  04-11-2026  00:01  1  I  1\r\n")
        self.assertEqual(app.timestamp("2026-11-03T17:01:00Z").date(), date(2026, 11, 4))

    def test_invalid_data_and_ambiguous_email_report_row(self):
        cases = [tables(punches=[["a", "X", "2026-11-04 08:00:00"]]),
                 tables(punches=[["a", 19, "04/11/2026 08:00"]]),
                 tables(punches=[["a", 19, ""]]),
                 tables(punches=[["a", "", "2026-11-04 08:00:00"]]),
                 tables(punches=[["a", "", "2026-11-04 08:00:00"]],
                        employees=[["a", 19, True], ["a", 24, False]])]
        for source in cases:
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "Punches row 2"):
                self.render(source)

    def test_empty_and_headers(self):
        self.assertEqual(self.render(tables()), b"")
        source = tables()
        source["Punches"] = [["Email"]]
        with self.assertRaisesRegex(ValueError, "missing headers"):
            self.render(source)


class AuthServer(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ("test", "secret") else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class LocalSFTP(paramiko.SFTPServerInterface):
    def __init__(self, server, *args, root, bad_size=False, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.root = Path(root)
        self.bad_size = bad_size

    def local(self, path):
        target = (self.root / path.lstrip("/")).resolve()
        if not target.is_relative_to(self.root.resolve()):
            raise OSError("outside test root")
        return target

    def stat(self, path):
        try:
            result = paramiko.SFTPAttributes.from_stat(self.local(path).stat())
            if self.bad_size:
                result.st_size += 1
            return result
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    lstat = stat

    def open(self, path, flags, attr):
        try:
            descriptor = os.open(self.local(path), flags, 0o600)
            handle = paramiko.SFTPHandle(flags)
            handle.writefile = os.fdopen(descriptor, "wb")
            return handle
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)


class MockSFTP:
    def __init__(self, root, bad_size=False):
        self.root = Path(root)
        (self.root / "POLA/Inbound/TM").mkdir(parents=True)
        self.key = paramiko.RSAKey.generate(2048)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(0.2)
        self.port = self.listener.getsockname()[1]
        self.bad_size = bad_size
        self.transport = None
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def serve(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.listener.accept()
                self.transport = paramiko.Transport(connection)
                self.transport.add_server_key(self.key)
                self.transport.set_subsystem_handler("sftp", paramiko.SFTPServer, LocalSFTP,
                                                     root=self.root, bad_size=self.bad_size)
                self.transport.start_server(server=AuthServer())
                self.transport.join(10)
            except (OSError, EOFError, paramiko.SSHException):
                pass

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stopped.set()
        if self.transport:
            self.transport.close()
        self.listener.close()
        self.thread.join(2)

    def known_hosts(self, path, wrong=False):
        keys = paramiko.HostKeys()
        key = paramiko.RSAKey.generate(2048) if wrong else self.key
        keys.add(f"[127.0.0.1]:{self.port}", key.get_name(), key)
        keys.save(str(path))
        return path

    @property
    def config(self):
        return {"host": "127.0.0.1", "port": self.port, "username": "test", "password": "secret",
                "destination": "POLA/Inbound/TM"}


class SFTPTests(unittest.TestCase):
    def test_tofu_first_connection_repeat_and_changed_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hosts = root / "sftp_known_hosts"
            with MockSFTP(root / "remote") as server:
                config = {**server.config, "host_key_policy": "tofu"}
                with app.sftp_connection(config, hosts) as sftp:
                    self.assertIsNotNone(sftp.stat(config["destination"]).st_mode)
                saved = hosts.read_bytes()
                with app.sftp_connection(config, hosts):
                    pass
                self.assertEqual(hosts.read_bytes(), saved)
                server.key = paramiko.RSAKey.generate(2048)
                with self.assertRaises(paramiko.BadHostKeyException):
                    with app.sftp_connection(config, hosts):
                        self.fail("changed key accepted")
                self.assertEqual(hosts.read_bytes(), saved)
                self.assertEqual(list((server.root / config["destination"]).iterdir()), [])

    def test_tofu_rejects_new_key_algorithm_for_pinned_host(self):
        with tempfile.TemporaryDirectory() as directory:
            hosts = Path(directory) / "known_hosts"
            with paramiko.SSHClient() as client:
                app.remember_first_key(client, "[example]:8022", paramiko.RSAKey.generate(2048), hosts)
                saved = hosts.read_bytes()
                with self.assertRaises(paramiko.SSHException):
                    app.remember_first_key(client, "[example]:8022", paramiko.ECDSAKey.generate(), hosts)
                self.assertEqual(hosts.read_bytes(), saved)

    def test_success_collision_wrong_host_and_size_mismatch(self):
        for mode in ("success", "collision", "wrong_host", "size_mismatch", "unknown_host"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "2026110494928.txt"
                source.write_bytes(b"0019  04-11-2026  08:30  1  I  1\r\n")
                with MockSFTP(root / "remote", bad_size=mode == "size_mismatch") as server:
                    hosts = server.known_hosts(root / "known_hosts", wrong=mode == "wrong_host")
                    if mode == "unknown_host":
                        hosts.write_text("")
                    remote = server.root / "POLA/Inbound/TM" / source.name
                    if mode == "collision":
                        remote.write_bytes(b"existing")
                    if mode == "success":
                        app.upload(source, server.config, hosts)
                        self.assertEqual(remote.read_bytes(), source.read_bytes())
                    elif mode == "collision":
                        with self.assertRaises(FileExistsError):
                            app.upload(source, server.config, hosts)
                        self.assertEqual(remote.read_bytes(), b"existing")
                    elif mode == "size_mismatch":
                        with self.assertRaisesRegex(IOError, "size"):
                            app.upload(source, server.config, hosts)
                    else:
                        with self.assertRaises(paramiko.SSHException):
                            app.upload(source, server.config, hosts)
                        self.assertFalse(remote.exists())

    def test_connection_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hosts = root / "known_hosts"
            hosts.write_text("")
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            # Socket bound but not listening: connection must be refused.
            try:
                with self.assertRaises(OSError):
                    app.upload(root / "sample.txt", {"host": "127.0.0.1", "port": port,
                               "username": "test", "password": "secret", "destination": "x"}, hosts)
            finally:
                sock.close()


class JobTests(unittest.TestCase):
    def test_check_sftp_does_not_read_sheets_or_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with MockSFTP(root / "remote") as server, patch.dict(os.environ, {"DATA_DIR": str(root / "data")}), \
                 patch.object(app, "load_sftp_config", return_value={**server.config, "host_key_policy": "tofu"}), \
                 patch.object(app, "read_sheets") as sheets, patch.object(app, "upload") as upload:
                args = app.argparse.Namespace(start_date=None, end_date=None, dry_run=False, check_sftp=True)
                app.run(args)
                sheets.assert_not_called()
                upload.assert_not_called()
                self.assertTrue((root / "data/sftp_known_hosts").is_file())
                self.assertEqual(list((root / "data").rglob("*.txt")), [])

    def test_default_window_and_original_filename(self):
        fixed = datetime(2026, 11, 4, 9, 49, 28, tzinfo=app.TZ)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "DATA_DIR": directory, "SPREADSHEET_ID": "dummy", "GOOGLE_APPLICATION_CREDENTIALS": "dummy"
        }), patch.object(app, "datetime") as clock, patch.object(app, "read_sheets", return_value=tables()), \
             patch.object(app, "export_bytes", return_value=b"example\r\n") as render:
            clock.now.return_value = fixed
            args = app.argparse.Namespace(start_date=None, end_date=None, dry_run=True)
            app.run(args)
            self.assertEqual(render.call_args.args[1:], (date(2026, 10, 29), date(2026, 11, 4), fixed))
            self.assertEqual((Path(directory) / "dry-run/2026110494928.txt").read_bytes(), b"example\r\n")
            with self.assertRaises(FileExistsError):
                app.run(args)

    def test_historical_date_override(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "DATA_DIR": directory, "SPREADSHEET_ID": "dummy", "GOOGLE_APPLICATION_CREDENTIALS": "dummy"
        }), patch.object(app, "read_sheets", return_value=tables()), patch.object(app, "export_bytes", return_value=b"") as render:
            args = app.argparse.Namespace(start_date=date(2024, 1, 1), end_date=date(2024, 1, 31), dry_run=True)
            app.run(args)
            self.assertEqual(render.call_args.args[1:3], (args.start_date, args.end_date))

    def test_dry_run_success_failure_and_empty(self):
        for mode in ("dry_run", "success", "failure", "empty"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                cutoff = datetime.now(app.TZ).replace(hour=0, minute=0, second=0, microsecond=0)
                source = tables() if mode == "empty" else tables(punches=[["a", 19, str(cutoff)]])
                args = app.argparse.Namespace(start_date=None, end_date=None, dry_run=mode == "dry_run")
                env = {"DATA_DIR": directory, "SPREADSHEET_ID": "dummy", "GOOGLE_APPLICATION_CREDENTIALS": "dummy",
                       "SFTP_KNOWN_HOSTS": "dummy"}
                with patch.dict(os.environ, env), patch.object(app, "read_sheets", return_value=source), \
                     patch.object(app, "load_sftp_config", return_value={}), patch.object(app, "upload") as upload:
                    if mode == "failure":
                        upload.side_effect = OSError("network lost")
                        with self.assertRaises(OSError):
                            app.run(args)
                        self.assertEqual(len(list((Path(directory) / "pending").glob("*.txt"))), 1)
                        self.assertEqual(len(list((Path(directory) / "uploaded").glob("*.txt"))), 0)
                        upload.assert_called_once()
                    else:
                        app.run(args)
                        if mode in ("dry_run", "empty"):
                            upload.assert_not_called()
                        else:
                            upload.assert_called_once()
                        expected = {"dry_run": "dry-run", "success": "uploaded"}.get(mode)
                        self.assertEqual(len(list(Path(directory).rglob("*.txt"))), int(expected is not None))
                        if expected:
                            self.assertEqual(len(list((Path(directory) / expected).glob("*.txt"))), 1)

    def test_lock_across_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "lock"
            script = "import attendance_export as a; import sys\nwith a.job_lock(sys.argv[1]): pass"
            with app.job_lock(lock):
                result = subprocess.run([sys.executable, "-c", script, str(lock)],
                                        cwd=Path(app.__file__).parent, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("another attendance export is running", result.stderr)
            with app.job_lock(lock):
                pass

    def test_date_validation_and_filename(self):
        args = app.argparse.Namespace(start_date=date(2026, 1, 1), end_date=None, dry_run=True)
        with self.assertRaisesRegex(ValueError, "provided together"):
            app.run(args)
        args.end_date = date(2025, 12, 31)
        with self.assertRaisesRegex(ValueError, "after end"):
            app.run(args)


class SheetsTests(unittest.TestCase):
    def test_readonly_unformatted_request_and_optional_sheet(self):
        with patch("google.oauth2.service_account.Credentials.from_service_account_file") as credentials, \
             patch("googleapiclient.discovery.build") as build:
            api = build.return_value.__enter__.return_value
            api.spreadsheets.return_value.get.return_value.execute.return_value = {
                "sheets": [{"properties": {"title": name}} for name in ["Employees", "Punches"]]
            }
            api.spreadsheets.return_value.values.return_value.batchGet.return_value.execute.return_value = {
                "valueRanges": [{"values": [["Email", "EmployeeId"]]},
                                {"values": [["Email", "EmployeeId", "PunchTime"]]}]
            }
            result = app.read_sheets("sheet-id", "credential-file")
            credentials.assert_called_once_with("credential-file", scopes=[app.SCOPE])
            api.spreadsheets.return_value.values.return_value.batchGet.assert_called_once_with(
                spreadsheetId="sheet-id", ranges=["'Employees'!A:Z", "'Punches'!A:Z"],
                valueRenderOption="UNFORMATTED_VALUE", dateTimeRenderOption="SERIAL_NUMBER")
            self.assertEqual(result["Attendance"], [["Email", "EmployeeId", "ClockIn", "ClockOut"]])

    def test_missing_required_sheets(self):
        with patch("google.oauth2.service_account.Credentials.from_service_account_file"), \
             patch("googleapiclient.discovery.build") as build:
            api = build.return_value.__enter__.return_value
            api.spreadsheets.return_value.get.return_value.execute.return_value = {"sheets": []}
            with self.assertRaisesRegex(ValueError, "requires Employees"):
                app.read_sheets("sheet-id", "credential-file")


if __name__ == "__main__":
    unittest.main()
