# tg-bot-finder — Tìm bot Telegram theo keyword cho 9router

Tìm `botUsername` để đăng ký vào supplier source `telegram_bot_scraper`. Dùng MTProto
(account Telegram thật) vì Bot API không tìm được bot khác.

## ⚠️ Cảnh báo rủi ro
- Search bot (đọc) tương đối an toàn nếu lượng nhỏ, chậm.
- `--join-groups` (tự join group + quét member) là **hành động ghi**, Telegram phạt nặng:
  có thể **ban vĩnh viễn số điện thoại**. Mặc định TẮT. Nếu bật, **dùng account phụ**, giữ
  `--max-joins` thấp, đừng hạ các hằng số rate-limit trong `find_bots.py`.
- Scrape hàng loạt vi phạm ToS Telegram. Tự chịu trách nhiệm.

## Cài đặt
```bash
pip install telethon
# Lấy api_id/api_hash: https://my.telegram.org → API development tools
```

## Quy trình

### Bước 1 — Xuất danh sách bot đã đăng ký (để đánh dấu/lọc)
Chạy bằng Node, cần `STORE_ENC_KEY` + đường dẫn `data.sqlite` giống 9router:
```bash
# Local (DB mặc định ~/.9router/db/data.sqlite hoặc $DATA_DIR/db/data.sqlite)
STORE_ENC_KEY=<key> node scripts/tg-bot-finder/export-registered-bots.mjs --out registered.json

# Chỉ định DB thủ công
STORE_ENC_KEY=<key> node scripts/tg-bot-finder/export-registered-bots.mjs \
  --db /app/data/db/data.sqlite --out registered.json
```
Prod chạy trên Dokploy → lấy `data.sqlite` + `STORE_ENC_KEY` từ container, hoặc bỏ qua bước
này (không có `registered.json` thì tool vẫn chạy, chỉ không đánh dấu được bot đã đăng ký).

### Bước 2 — Tìm bot (chạy trong TERMINAL THẬT để nhập OTP)
> Prompt OTP/keyword cần TTY tương tác — KHÔNG chạy qua Claude `!`, phải chạy trong Terminal.app/iTerm.

```bash
cd scripts/tg-bot-finder
export TG_API_ID=<id> TG_API_HASH=<hash>

# Cơ bản — chỉ search theo keyword mình nhập
python3 find_bots.py "nạp game, thẻ cào, topup"

# Có sẵn registered.json → tự đánh dấu [ĐÃ ĐĂNG KÝ]; thêm --hide-registered để ẩn hẳn
python3 find_bots.py "nạp game, thẻ cào" --registered registered.json --hide-registered

# Bật AI tự sinh keyword + loop (key 9router tự tạo trong dashboard)
python3 find_bots.py "nạp game" --ai-rounds 3 \
  --router-url https://router.chainlens.net --router-key <key_9router> --model glm-4.6

# ⚠️ Bật join group quét member (RỦI RO BAN — account phụ)
python3 find_bots.py "nạp game" --join-groups --max-joins 2 --out result.json
```
Lần đầu hỏi SĐT (`+84...`) + OTP, lưu `find_bots.session` cho lần sau.

## Tham số chính
| Cờ | Ý nghĩa | Mặc định |
|----|---------|----------|
| `keywords` | keyword gốc, cách nhau dấu phẩy (bỏ trống → hỏi nhập) | — |
| `--registered <file>` | file bot đã đăng ký (bước 1) | `registered.json` |
| `--hide-registered` | ẩn hẳn bot đã đăng ký khỏi kết quả | tắt (chỉ ghi note) |
| `--ai-rounds N` | số vòng AI sinh keyword mới | `0` (tắt) |
| `--router-url / --router-key / --model` | gọi model trên 9router | env `ROUTER_*` |
| `--join-groups` | ⚠️ tự join group quét member | tắt |
| `--max-joins / --max-members` | trần join / member quét | `3 / 200` |
| `--out <file>` | ghi kết quả JSON | — |

## Output
- Bảng `@username | tên | nguồn (search:kw / group:title) | [ĐÃ ĐĂNG KÝ]`.
- Dòng cuối `[dán vào config] @bot1,@bot2,...` — chỉ bot CHƯA đăng ký, dán vào supplier source.

## Giới hạn
- `contacts.search` Telegram cắt ~vài chục kết quả/keyword, **không phân trang** → phủ rộng bằng nhiều keyword (AI giúp việc này).
- AI cần key 9router của anh (key gọi `/v1`, tạo trong dashboard), không phải secret hệ thống.
