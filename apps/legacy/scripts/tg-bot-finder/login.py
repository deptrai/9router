#!/usr/bin/env python3
"""
login.py — đăng nhập Telegram 2 bước NON-INTERACTIVE (để chạy được qua harness không có TTY).

Bước 1 (gửi OTP):
    TG_API_ID=.. TG_API_HASH=.. python3 login.py send --phone +84...
  → Telegram gửi mã, in ra phone_code_hash, lưu tạm vào .login_state.json, rồi THOÁT.

Bước 2 (nhập OTP):
    TG_API_ID=.. TG_API_HASH=.. python3 login.py code --code 12345
  → đăng nhập, lưu session find_bots.session. Nếu bật 2FA: thêm --password <mk>.

Sau khi xong, find_bots.py dùng lại find_bots.session, không hỏi gì nữa.
"""
import os
import sys
import json
import asyncio
import argparse

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError

STATE_FILE = ".login_state.json"


async def do_send(client, phone):
    await client.connect()
    if await client.is_user_authorized():
        print("[login] Đã đăng nhập sẵn — session còn hiệu lực, không cần OTP.")
        await client.disconnect()
        return
    sent = await client.send_code_request(phone)
    with open(STATE_FILE, "w") as f:
        json.dump({"phone": phone, "phone_code_hash": sent.phone_code_hash}, f)
    print(f"[login] Đã gửi OTP tới {phone}. Nhập lại bằng: login.py code --code <mã>")
    await client.disconnect()


async def do_code(client, code, password):
    await client.connect()
    if await client.is_user_authorized():
        print("[login] Đã đăng nhập sẵn.")
        await client.disconnect()
        return
    if not os.path.exists(STATE_FILE):
        print("[login] Chưa có .login_state.json — chạy 'send' trước.", file=sys.stderr)
        await client.disconnect()
        sys.exit(1)
    with open(STATE_FILE) as f:
        st = json.load(f)
    try:
        await client.sign_in(phone=st["phone"], code=code, phone_code_hash=st["phone_code_hash"])
    except SessionPasswordNeededError:
        if not password:
            print("[login] Account bật 2FA — chạy lại: login.py code --code <mã> --password <mk>", file=sys.stderr)
            await client.disconnect()
            sys.exit(2)
        await client.sign_in(password=password)
    except PhoneCodeInvalidError:
        print("[login] Mã OTP sai — chạy lại 'send' để lấy mã mới.", file=sys.stderr)
        await client.disconnect()
        sys.exit(3)
    me = await client.get_me()
    print(f"[login] OK — đăng nhập thành công: {me.first_name} (@{me.username or me.id})")
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    await client.disconnect()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("step", choices=["send", "code"])
    p.add_argument("--phone")
    p.add_argument("--code")
    p.add_argument("--password")
    p.add_argument("--session", default="find_bots")
    args = p.parse_args()

    api_id = int(os.environ["TG_API_ID"])
    api_hash = os.environ["TG_API_HASH"]
    client = TelegramClient(args.session, api_id, api_hash)

    if args.step == "send":
        if not args.phone:
            print("send cần --phone +84...", file=sys.stderr); sys.exit(1)
        asyncio.run(do_send(client, args.phone))
    else:
        if not args.code:
            print("code cần --code <mã OTP>", file=sys.stderr); sys.exit(1)
        asyncio.run(do_code(client, args.code, args.password))


if __name__ == "__main__":
    main()
