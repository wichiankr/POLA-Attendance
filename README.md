# POLA WFH Attendance: Google Apps Script + LINE LIFF

```
original/   โค้ดเดิม v1.1 (สำรองไว้)
improved/   Apps Script v1.3: วางทับในโปรเจกต์ Apps Script
docs/       หน้า LIFF สำหรับ GitHub Pages (index.html + config.js)
```

## การทำงาน

```
LINE app ─► LIFF (GitHub Pages: docs/index.html)
              │ liff.getIDToken()
              ▼ POST {idToken, action}   (Content-Type: text/plain)
           Apps Script doPost()  ─► ตรวจ ID token กับ api.line.me/oauth2/v2.1/verify → LINE userId
              ▼
           Google Sheet: Employees.LineUserId (คอลัมน์ F) ↔ Attendance
```

- **ครั้งแรก:** พนักงานกรอกอีเมลบริษัท แล้วระบบส่ง OTP 6 หลักไปที่อีเมลนั้น พอกรอก OTP ถูก ระบบจะบันทึก LINE userId ลงคอลัมน์ F ของพนักงานคนนั้น
- **ครั้งถัดไป:** เปิดจาก LINE แล้วใช้งานได้ทันที
- หน้าเว็บ Google เดิม (`doGet`) ยังใช้ได้เหมือนเดิม

---

## ขั้นตอนติดตั้ง

### 1. Apps Script
1. เปิดโปรเจกต์ แล้ววางเนื้อหา `improved/Code.gs`, `improved/Index.html` และ `improved/appsscript.json` ทับไฟล์เดิม
2. รัน `setup()` จาก editor หนึ่งครั้ง ระบบจะเพิ่มคอลัมน์ `LineUserId` ในชีต Employees
3. ไปที่ **Project Settings → Script properties** แล้วเพิ่ม:
   | Property | ค่า |
   |---|---|
   | `LINE_CHANNEL_ID` | Channel ID ของ LINE Login channel (จากข้อ 2) |
   | `LINE_MESSAGING_TOKEN` | *(ไม่บังคับ)* Channel access token ของ Messaging API ใช้สำหรับแจ้งเตือน |
   | `LOCATION_REQUIRED` | *(ไม่บังคับ)* `true` = ต้องมีตำแหน่งจึงลงเวลาได้ ถ้าไม่ตั้งหรือเป็นค่าอื่น ระบบจะขอตำแหน่ง แต่ถ้าไม่อนุญาตก็ยังลงเวลาได้ |
4. ไปที่ **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - คัดลอก URL ที่ลงท้ายด้วย `/exec` ไว้ใช้ใน `config.js`
   - ตอนกด authorize ระบบจะขอสิทธิ์ใหม่ 2 อย่าง คือ *external requests* (ไว้ตรวจ token กับ LINE) และ *send email* (ไว้ส่ง OTP)
   - ถ้ายังต้องการหน้าเว็บ Google เดิม ให้เก็บ deployment เดิมที่ตั้งเป็น "Anyone within domain" ไว้ด้วย

### 2. LINE Developers Console
1. สร้าง Provider ถ้ามี LINE OA อยู่แล้ว ให้ใช้ Provider เดียวกับ OA
2. สร้าง **LINE Login channel**
3. คัดลอก **Channel ID** ไปใส่ใน `LINE_CHANNEL_ID`
4. แท็บ **LIFF → Add**
   - Size: **Full**
   - Endpoint URL: `https://<github-user>.github.io/<repo>/`
   - Scopes: **openid** (จำเป็น)
   - คัดลอก **LIFF ID**
5. เปลี่ยนสถานะ channel จาก **Developing → Published** ถ้ายังเป็น Developing จะมีแค่ admin และ tester ที่ login ได้

### 3. GitHub Pages
1. แก้ `docs/config.js` ใส่ `LIFF_ID` และ `API_URL`
2. push ขึ้น GitHub
3. ไปที่ **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`**
4. ถ้าใช้ GitHub แบบฟรี repo ต้องเป็น public ข้อนี้ไม่มีปัญหา เพราะในโค้ดไม่มี secret: ID ของ Spreadsheet และ token เก็บอยู่ใน Script properties

### 4. ให้พนักงานเข้าใช้
ใส่ลิงก์ `https://liff.line.me/<LIFF_ID>` ใน Rich menu ของ LINE OA หรือส่งลิงก์นี้ให้พนักงานโดยตรง

### 5. (ไม่บังคับ) แจ้งเตือนลืม Clock Out เวลา 19:00
1. สร้าง **Messaging API channel** ใต้ **Provider เดียวกัน** เพราะ LINE userId จะตรงกันเฉพาะ channel ที่อยู่ใต้ provider เดียวกัน
2. ออก Channel access token แล้วใส่ใน `LINE_MESSAGING_TOKEN`
3. รัน `installReminder()` จาก editor หนึ่งครั้ง
4. พนักงานต้องเพิ่ม LINE OA เป็นเพื่อนก่อนจึงจะได้รับข้อความ

---

## การแท็กตำแหน่ง (Location)
- ตอนกด Clock In / Clock Out หน้าเว็บจะขอตำแหน่ง GPS จากเครื่อง (`navigator.geolocation`) ครั้งแรก LINE หรือเบราว์เซอร์จะถามขออนุญาต
- บันทึกลงชีต Attendance ใน 6 คอลัมน์ใหม่ (K–P):
  | คอลัมน์ | ตัวอย่าง |
  |---|---|
  | `InLocation` / `OutLocation` | `13.724600,100.579400` |
  | `InAccuracyM` / `OutAccuracyM` | `18` (ความคลาดเคลื่อนเป็นเมตร) |
  | `InPlace` / `OutPlace` | ที่อยู่จาก Google Maps เช่น "ถนนสุขุมวิท แขวงคลองเตย…" |
- **รัน `setup()` อีกครั้งหลังอัปเดตโค้ด** เพื่อเพิ่มหัวคอลัมน์ใหม่ ข้อมูลเดิมไม่หาย
- พนักงานเห็นตำแหน่งของวันนี้บนหน้าจอ และกดเปิดใน Google Maps ได้
- ข้อจำกัด:
  - ตำแหน่งมาจากเครื่องของพนักงาน แอปปลอม GPS สามารถหลอกได้ ใช้เป็นหลักฐานประกอบได้ แต่ไม่ใช่หลักฐานที่ปลอมไม่ได้
  - หน้าเว็บ Google (`doGet`) ทำงานใน iframe ของ Google ซึ่งอาจถูกบล็อกการเข้าถึงตำแหน่ง ถ้าตั้ง `LOCATION_REQUIRED=true` ให้ใช้ผ่าน LINE
- **PDPA:** ตำแหน่งเป็นข้อมูลส่วนบุคคล ควรแจ้งพนักงานเป็นลายลักษณ์อักษรว่าเก็บข้อมูลเพื่ออะไรและเก็บนานเท่าไร (หน้าจอมีข้อความแจ้งว่าบันทึกเฉพาะตอนกดลงเวลา) และจำกัดสิทธิ์ดูชีตเฉพาะ HR

## ความปลอดภัย
- ระบบระบุตัวพนักงานจาก **ID token ที่ LINE รับรองแล้วเท่านั้น** และไม่เชื่อ userId หรืออีเมลที่ส่งมาจากหน้าเว็บ ระบบตรวจ `iss`, `aud` (= Channel ID) และ `exp` ทุกครั้ง
- การผูกบัญชีใช้ OTP ที่ส่งไปยังอีเมลบริษัท:
  - รหัสสุ่มด้วย SecureRandom ใช้ได้ 10 นาที ใช้ได้ครั้งเดียว และผูกกับ LINE account ที่ขอรหัส
  - กรอกผิด 5 ครั้งรหัสจะถูกยกเลิก
  - ขอรหัสใหม่ได้ 1 ครั้งต่อนาที ทั้งต่อ LINE account และต่ออีเมล
- ระบบตอบเหมือนกันไม่ว่าอีเมลจะอยู่ในรายชื่อพนักงานหรือไม่ จึงใช้หน้านี้เดารายชื่อพนักงานไม่ได้
- LINE 1 บัญชีผูกกับพนักงานได้ 1 คน ถ้าผูกใหม่ ระบบจะลบ LINE ID เดิมออกจากแถวอื่น
- **พนักงานลาออก:** ตั้ง Active = FALSE แล้วระบบจะปฏิเสธทันที ทั้งทาง LINE และทาง Google
- **พนักงานเปลี่ยนเครื่องหรือเปลี่ยนบัญชี LINE:** ผูกใหม่ด้วย OTP หรือให้ HR ลบค่าในคอลัมน์ F
- **ห้ามแชร์ Spreadsheet ให้พนักงาน:** Apps Script ทำงานด้วยสิทธิ์เจ้าของอยู่แล้ว
- `setup()`, `installReminder()` และ `remindClockOut()` รันได้เฉพาะเจ้าของหรือ trigger ของระบบเท่านั้น

## ทดสอบ
ทดสอบฝั่ง server ด้วย Node โดยจำลอง Apps Script ไว้ ครอบคลุม: ลงเวลาปกติ, กะข้ามเที่ยงคืน, ลืม Clock Out, แถวข้อมูลเก่า, การตรวจตัวตน, การป้องกัน `setup()`, LIFF API (token, OTP, brute force, rate limit) และการแจ้งเตือน
