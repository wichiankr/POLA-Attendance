# Attendance → SFTP บน Ubuntu

Python job สำหรับข้อมูลในโปรเจกต์ POLA WFH Attendance อ่าน Google Sheets อย่างเดียว สรุปเวลาเข้าแรกสุดและออกล่าสุด แล้วส่ง text file ผ่าน SFTP โดยไม่แก้ Apps Script หรือชีตต้นทาง

## พฤติกรรม

- ทุกวัน **11:00 และ 23:00 เวลา Asia/Bangkok** ใช้ systemd timer เรียก Docker แบบ one-shot ไม่ต้องเปิด container ค้างไว้
- อ่านตั้งแต่วันที่ไทยปัจจุบันลบ 6 วัน จนถึงเวลาที่เริ่ม job เช่น รันวันที่ 4 พฤศจิกายน จะอ่าน 29 ตุลาคม–4 พฤศจิกายน ไม่รวม timestamp หลังเริ่ม job
- แต่ละรอบส่งข้อมูลทั้งหมดในช่วงนั้นใหม่ ไม่มี checkpoint ป้องกันรายการซ้ำระหว่างรอบ ตามข้อตกลงให้ระบบรับจัดการรายการซ้ำ
- อ่าน `Punches` และ `Attendance` เก่ารวมกัน จัดกลุ่มตาม EmployeeId + วันที่จริงของ timestamp ไม่ใช้ WorkDate และไม่แบ่งกะข้ามเที่ยงคืน
- เลือก timestamp แรก/สุดท้าย ตัดวินาทีตอนเขียน ถ้าเหลือเวลาในนาทีเดียวกันจะเขียนบรรทัดเดียว เรียงวัน เวลา แล้วรหัสพนักงาน
- รองรับวันที่แบบ ISO `yyyy-MM-dd HH:mm:ss` และ Sheets date serial ซึ่งตีความเป็นเวลาไทย; timestamps ที่มี timezone จะถูกแปลงเป็นเวลาไทย
- EmployeeId รับตัวเลข 1–4 หลัก เติมศูนย์ซ้ายเป็น 4 หลัก หากไม่มีให้หา email ใน `Employees` แบบไม่สนใจตัวพิมพ์เล็ก/ใหญ่ ต้องพบเพียงแถวเดียว ไม่กรอง Active จึงส่งประวัติพนักงาน inactive ด้วย
- ตาราง `Employees` ต้องมีอยู่ ส่วน `Punches` หรือ `Attendance` ขาดได้หนึ่งตาราง แต่ตารางที่มีอยู่ต้องมี headers ถูกต้อง อ่านชื่อ header จึงรองรับลำดับคอลัมน์ที่เปลี่ยน
- ตรวจ timestamp ของทุกแถวที่ไม่ว่างก่อนกรองวัน หาก timestamp ผิดจะหยุดทั้งรอบ; ตรวจรหัสพนักงานสำหรับรายการในช่วงส่ง ข้อผิดพลาดบอกชื่อชีตและเลขแถวโดยไม่แสดงข้อมูลพนักงาน
- ไม่มีข้อมูลจะจบสำเร็จโดยไม่สร้างไฟล์หรือเชื่อมต่อ SFTP

ไฟล์อ้างอิง `2024111294928.txt` มี 11,814 บรรทัด ทุกบรรทัดเป็นรูปแบบนี้:

```text
0019  04-11-2026  08:30  1  I  1
0019  04-11-2026  17:30  1  I  1
```

คั่นช่องด้วย **space สองตัว** ไม่มี header ใช้ ASCII ไม่มี BOM ขึ้นบรรทัดด้วย CRLF รวมท้ายไฟล์ ทุกบรรทัดยาว 32 bytes ไม่รวม CRLF ใช้ `1  I  1` ทั้งเวลาเข้าและออก ชื่อไฟล์ใช้เวลาที่เริ่ม job `yyyyMMddHmmss.txt` ชั่วโมงไม่เติมศูนย์ เช่น `2026110494928.txt` สำหรับ 09:49:28

## เตรียม Google และ SFTP

1. เปิด Google Sheets API ใน Google Cloud project สร้าง service account และดาวน์โหลด JSON key
2. แชร์ spreadsheet ให้ `client_email` ใน JSON ด้วยสิทธิ์ **Viewer** เท่านั้น โปรแกรมขอ scope `spreadsheets.readonly` ไม่ต้อง domain-wide delegation
3. คัดลอก Spreadsheet ID จาก URL ส่วน `/spreadsheets/d/<ID>/` ค่าใน Apps Script อยู่ใน Script property `SPREADSHEET_ID`
4. นำ host/username/password/port จาก `SFTPupload.exe.config` ที่ใช้งานจริงมาตั้งใน `secrets/sftp.json` ไม่ต้องคัดลอก secrets เข้า repository ไฟล์ที่ได้รับล่าสุดใช้ port **`8022`** (ต่างจาก App.config ใน source เดิมที่เป็น `22`) และ destination `POLA/Inbound/TM` ซึ่งเป็น path สัมพัทธ์กับ SFTP home และต้องมีอยู่แล้ว ตัว runtime config ถูก gitignore และไม่รวมใน Docker build context
5. Ubuntu ต้องเชื่อมต่อ Google APIs และ SFTP server ได้ หากเป็นเครือข่ายภายในต้องอยู่ใน network/VPN ที่เข้าถึงปลายทางได้

## ติดตั้งบน Ubuntu

ต้องมี Docker Engine + Compose plugin และ systemd เตรียม repository ที่ `/opt/pola-attendance` เพื่อให้ตรงกับ service file (ถ้าใช้ที่อื่นแก้ `WorkingDirectory` ก่อนติดตั้ง service)

ดึงเฉพาะโฟลเดอร์นี้จาก GitHub ด้วย sparse checkout (สำหรับ server ที่ยังไม่มี checkout):

```bash
sudo git clone --filter=blob:none --sparse https://github.com/wichiankr/POLA-Attendance.git /opt/pola-attendance
sudo git -C /opt/pola-attendance sparse-checkout set attendance-export
```

working tree จะมี `attendance-export` และไฟล์ระดับ root ของ repository แต่ไม่ดึงโฟลเดอร์เว็บหรือ Apps Script มารัน Compose build ใช้ context เฉพาะ `attendance-export` และ image มีเฉพาะโปรแกรมกับ dependencies

นำ `.env`, `secrets/service-account.json`, `secrets/sftp.json` และ `data/sftp_known_hosts` จากเครื่องที่ทดสอบแล้วไปวางผ่านช่องทาง SSH ที่เชื่อถือได้ ไฟล์เหล่านี้ไม่อยู่บน GitHub โดยเฉพาะ `data/sftp_known_hosts` ต้องย้าย pin เดิมไปด้วยและตั้ง owner UID/GID 10001 ให้ container อ่านได้ หากใช้ TOFU ไม่จำเป็นต้องมี `secrets/known_hosts` ส่วนการสร้างไฟล์ตัวอย่างด้านล่างใช้เฉพาะกรณีที่ยังไม่มี config

```bash
cd /opt/pola-attendance/attendance-export
sudo install -d -o 10001 -g 10001 -m 0700 data
sudo install -d -o root -g 10001 -m 0750 secrets
sudo cp .env.example .env
sudo cp sftp.example.json secrets/sftp.json
sudo install -o root -g 10001 -m 0640 /secure/path/service-account.json secrets/service-account.json
sudo chown root:10001 secrets/sftp.json
sudo chmod 0640 secrets/sftp.json
sudo chmod 0600 .env
sudoedit .env
sudoedit secrets/sftp.json
```

ตั้ง `SPREADSHEET_ID` ใน `.env` และ host/username/password ใน `secrets/sftp.json` ไฟล์ตัวอย่างไม่มี credentials จริง หากรหัสผ่านมี quote หรือ backslash ต้อง escape ตาม JSON

### Host key: TOFU สำหรับ vendor ที่ไม่มี key ให้

ตั้ง `"host_key_policy": "tofu"` ใน `secrets/sftp.json` (ไฟล์ตัวอย่างใช้ค่านี้แล้ว) ครั้งแรกโปรแกรมจะจำ public host key จาก SFTP server ก่อนส่ง credentials และบันทึกแบบ atomic ลง `data/sftp_known_hosts` ครั้งถัดไปต้องตรงกับ key ที่จำไว้ หาก key หรือชนิด key เปลี่ยนจะหยุด ไม่รับ key ใหม่อัตโนมัติ

TOFU อาศัยความเชื่อถือในเครือข่ายขณะเชื่อมต่อครั้งแรก ไม่ใช่การยืนยัน key กับ vendor ควรสำรองและย้าย `data/sftp_known_hosts` ไปพร้อมระบบเมื่อ deploy บน Ubuntu เพื่อไม่เริ่มเชื่อถือใหม่ ถ้า vendor เปลี่ยน key ให้ตรวจสอบเหตุผลก่อนเปลี่ยน pin อย่าลบไฟล์นี้เพื่อข้าม error โดยไม่ตรวจสอบ

ทดสอบ login และตรวจว่ามีโฟลเดอร์ปลายทางโดยไม่อัปโหลดไฟล์ (TOFU จะบันทึก key ในครั้งแรก):

```bash
sudo docker compose build
sudo docker compose run --rm --no-deps attendance-export --check-sftp
sudo docker compose run --rm --no-deps attendance-export --dry-run
```

การตรวจนี้ไม่สร้างไฟล์บน SFTP จึงยังไม่ยืนยันสิทธิ์เขียนหรือการนำเข้าของระบบปลายทาง

### ทางเลือก: Strict เมื่อมี key ที่ยืนยันแล้ว

ตั้ง `"host_key_policy": "strict"` เพื่อใช้ `secrets/known_hosts` แบบอ่านอย่างเดียว หากไม่ได้ระบุ policy โปรแกรมใช้ strict เป็นค่าเริ่มต้น รับ host key ผ่านช่องทางที่ผู้ดูแล SFTP ยืนยัน ถ้าจะรวบรวมจาก network ให้เก็บเป็น candidate และเปรียบเทียบ fingerprint กับผู้ดูแลก่อนใช้:

```bash
ssh-keyscan -p 8022 YOUR_SFTP_HOST > /tmp/pola-known-hosts.candidate
ssh-keygen -lf /tmp/pola-known-hosts.candidate
# เมื่อผู้ดูแลยืนยัน fingerprint แล้วเท่านั้น:
sudo install -o root -g 10001 -m 0640 /tmp/pola-known-hosts.candidate secrets/known_hosts
sudo docker compose build
sudo docker compose run --rm --no-deps attendance-export --dry-run
sudo find data/dry-run -maxdepth 1 -type f -name '*.txt'
```

`--dry-run` อ่านชีตจริงและสร้างไฟล์ใน `data/dry-run/` แต่ไม่อ่าน SFTP config และไม่เปิด SFTP connection ตรวจไฟล์และค่าที่ตั้งก่อนเริ่มการส่งจริง

คำสั่งต่อไปนี้ **ส่งข้อมูลจริง** ใช้เมื่อพร้อมเปิดใช้งาน:

```bash
sudo docker compose run --rm --no-deps attendance-export
sudo install -m 0644 systemd/pola-attendance-export.service systemd/pola-attendance-export.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/pola-attendance-export.service /etc/systemd/system/pola-attendance-export.timer
sudo systemd-analyze calendar '*-*-* 11:00:00 Asia/Bangkok' '*-*-* 23:00:00 Asia/Bangkok'
sudo systemctl daemon-reload
sudo systemctl enable --now pola-attendance-export.timer
sudo systemctl list-timers --all pola-attendance-export.timer
```

timer ระบุ Asia/Bangkok โดยตรง จึงใช้ได้แม้ host ตั้งเป็น UTC และมี `Persistent=true`: ถ้าเครื่องปิดตอนถึงกำหนด จะรันชดเชยหนึ่งครั้งเมื่อ timer กลับมาทำงาน โดยคำนวณช่วง 7 วันจากเวลารันจริง ไม่ replay ทุกเวลาที่พลาด

## รันย้อนหลังและดูผล

ต้องระบุวันที่ต้นและท้ายคู่กัน รูปแบบ `YYYY-MM-DD` รวมวันต้นและท้าย และยังไม่รวม timestamp หลังเริ่ม job:

```bash
sudo docker compose run --rm --no-deps attendance-export --dry-run --start-date 2026-10-29 --end-date 2026-11-04
sudo docker compose run --rm --no-deps attendance-export --start-date 2026-10-29 --end-date 2026-11-04
sudo journalctl -u pola-attendance-export.service -n 100 --no-pager
sudo systemctl status pola-attendance-export.timer
sudo systemctl status pola-attendance-export.service
```

อัปเดต code บน production โดยไม่แก้ secrets/data ที่ถูก gitignore:

```bash
sudo systemctl stop pola-attendance-export.timer
sudo git -C /opt/pola-attendance pull --ff-only origin main
cd /opt/pola-attendance/attendance-export
sudo docker compose build
sudo docker compose run --rm --no-deps attendance-export --check-sftp
sudo docker compose run --rm --no-deps attendance-export --dry-run
sudo install -m 0644 systemd/pola-attendance-export.service systemd/pola-attendance-export.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start pola-attendance-export.timer
```

หยุดขั้นตอนอัปเดตหากคำสั่งใดล้มเหลว และตรวจ service ที่กำลังทำงานอยู่ก่อนเปลี่ยน code; การหยุด timer ไม่ได้หยุด export ที่เริ่มไปแล้ว ห้ามใช้ `git clean -fdx` เพราะจะลบ secrets/data ด้วย

ทุกโหมดใช้ lock เดียวกันบน `data/.export.lock` ป้องกัน job ซ้อนกัน รวม manual run ที่ mount data directory เดียวกัน ถ้ามีอีก job ทำงานอยู่จะ exit 1 ตัว lock file อาจค้างอยู่ตามปกติ แต่ OS จะปล่อย lock เมื่อ process สิ้นสุด

## การเก็บไฟล์และกรณีส่งไม่สำเร็จ

- สร้างไฟล์ด้วย exclusive creation ใน `data/pending/` ก่อนเชื่อมต่อ SFTP ไม่เขียนทับไฟล์เดิม
- ตรวจ host key ตาม policy: strict ใช้ `secrets/known_hosts`; tofu จำครั้งแรกใน `data/sftp_known_hosts` แล้วตรวจ pin ทุกครั้ง ไม่ใช้ SSH agent หรือ private key จากเครื่อง host
- ตรวจชื่อปลายทางและสร้างไฟล์ด้วย SFTP exclusive create เพื่อไม่เขียนทับ แม้มี writer อื่นทำงานพร้อมกัน
- ตรวจ remote size หลังปิดไฟล์สำเร็จ จึงย้ายไฟล์ local ไป `data/uploaded/` ถ้าชื่อชนหรือ archive ล้มเหลว job จะ exit 1
- หากเกิดความผิดพลาด เก็บ local file ใน pending ไม่ลบไฟล์ปลายทางและไม่ retry upload อัตโนมัติ ปลายทางอาจรับครบแล้วหรืออาจมีไฟล์บางส่วน ต้องให้ผู้ดูแลตรวจชื่อไฟล์ก่อนส่งซ้ำด้วยตนเอง
- รอบถัดไปยังคงส่ง snapshot 7 วันใหม่ตามที่กำหนด ไม่หยิบ pending เก่าไปส่งซ้ำ จึงต้องตรวจ pending และ service failures แยกต่างหาก
- ไฟล์ถูกเขียนด้วยชื่อจริงบน SFTP เช่นเดียวกับโปรเจกต์เดิม ระบบรับควรรอไฟล์เขียนเสร็จก่อนอ่าน การตรวจขนาดยืนยันการโอนไฟล์เท่านั้น ไม่ได้ยืนยันว่าระบบ attendance ปลายทางนำเข้าสำเร็จ
- ไม่ล้าง archive อัตโนมัติ ผู้ดูแลกำหนดระยะเก็บและสำรองข้อมูลตามนโยบายองค์กร ข้อมูลและ secrets อยู่นอก image และถูก gitignore

## ทดสอบในเครื่อง

```bash
python -m venv .venv
# Ubuntu:
. .venv/bin/activate
# PowerShell ใช้: .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python attendance_export.py --help
```

ชุดทดสอบไม่เชื่อมต่อ Google หรือ SFTP จริง ใช้ SSH/SFTP server จำลองบน loopback ที่มี host key ชั่วคราว เพื่อทดสอบการอัปโหลดจริงผ่าน Paramiko รวมกรณีชื่อชน host key ผิด/ไม่รู้จัก ขนาดไม่ตรง และ connection refused พร้อมทดสอบไฟล์ระดับ bytes, การสรุปข้อมูล, lock ข้าม process และ dry-run/archive/pending

รันทดสอบด้วย dependencies ใน image ที่ build แล้ว โดยไม่ mount secrets (ตัวอย่างคำสั่งสำหรับ Ubuntu):

```bash
sudo docker run --rm --read-only --tmpfs /tmp:size=32m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,source=$PWD/tests,target=/tests,readonly" \
  --entrypoint python pola-attendance-export:local -m unittest discover -s /tests -v
```

ผลตรวจในเครื่องพัฒนา: build image สำเร็จ ชุดทดสอบเพิ่มเป็น 19 tests รวม TOFU ครั้งแรก/ครั้งถัดไป การปฏิเสธ key ที่เปลี่ยน และ `--check-sftp` ที่ไม่อ่านชีตหรืออัปโหลด ตรวจตารางเวลาและ unit syntax ด้วย `systemd-analyze` ใน Ubuntu 24.04 container แล้ว โดยใช้ Docker dependency จำลองสำหรับตรวจ syntax เท่านั้น ยังไม่ได้เปิด timer บน server จริง การอ่าน Google Sheet แบบ dry-run ผ่านแล้ว ยังไม่ได้ส่ง SFTP จริง

ถ้ารัน Python โดยไม่ใช้ Docker ให้ตั้ง environment `SPREADSHEET_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `DATA_DIR`; สำหรับการส่งจริงเพิ่ม `SFTP_CONFIG_FILE` และ `SFTP_KNOWN_HOSTS` เป็นพาธไฟล์ที่ตั้งไว้
