#!/usr/bin/env python3
"""
find_bots.py — Tìm bot Telegram theo keyword (AI tự sinh keyword + loop) cho 9router.

Tính năng:
  • Tìm bot qua contacts.search (MTProto, account thật).
  • AI tự nghĩ keyword & loop nhiều vòng — gọi model trên router.chainlens.net
    (OpenAI-compatible /v1/chat/completions). AI đọc kết quả vòng trước để sinh
    keyword mới chưa thử, mở rộng độ phủ.
  • Đánh dấu bot ĐÃ ĐĂNG KÝ trong 9router (đọc registered.json do helper node xuất).
    --hide-registered để loại hẳn; mặc định giữ lại và ghi note [ĐÃ ĐĂNG KÝ].
  • (Tùy chọn, MẶC ĐỊNH TẮT) --join-groups: tự join group khớp keyword rồi quét
    member để moi thêm bot. ⚠️ RỦI RO BAN ACCOUNT — xem README.

Cài:  pip install telethon
Cred: https://my.telegram.org → API development tools
Chạy: xem README.md cùng thư mục.
"""
import os
import sys
import json
import asyncio
import argparse
import urllib.request

from telethon import TelegramClient, functions
from telethon.tl.types import Channel, Chat
from telethon.errors import FloodWaitError

# ---------------------------------------------------------------------------
# Rate-limit constants — cố tình chậm để tránh flood-ban. Đừng hạ xuống.
SEARCH_DELAY_SEC = 2.0       # nghỉ giữa mỗi lần search keyword
JOIN_DELAY_SEC = 45.0        # nghỉ giữa mỗi lần join group (join = hành động ghi, rất nhạy)
SEARCH_LIMIT = 50            # Telegram cắt ~vài chục/keyword, không phân trang được
DEFAULT_MAX_JOINS = 3        # trần số group join mỗi lần chạy


# ---------------------------------------------------------------------------
# AI keyword generation qua router.chainlens.net (OpenAI-compatible)
def ai_generate_keywords(base_url, api_key, model, seed_keywords, already_tried, found_count):
    """Gọi model để sinh keyword mới. Trả list[str]. Fail-soft → trả []."""
    url = base_url.rstrip("/") + "/v1/chat/completions"
    sys_prompt = (
        "Bạn giúp tìm bot Telegram bán sản phẩm số (nạp game, thẻ cào, tài khoản, topup...). "
        "Nhiệm vụ: sinh các keyword tìm kiếm TIẾNG VIỆT + một số tiếng Anh để tìm bot/group. "
        "Chỉ trả về JSON array các string keyword, không giải thích. "
        "Tránh lặp keyword đã thử. Ưu tiên keyword cụ thể, đa dạng cách gọi."
    )
    user_prompt = (
        f"Keyword gốc: {seed_keywords}\n"
        f"Đã thử ({len(already_tried)}): {sorted(already_tried)}\n"
        f"Số bot tìm được tới giờ: {found_count}\n"
        "Sinh 8 keyword MỚI chưa thử. Trả JSON array thuần."
    )
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.9,
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        content = data["choices"][0]["message"]["content"].strip()
        # Bóc ```json fences nếu có
        if content.startswith("```"):
            content = content.split("```")[1].lstrip("json").strip()
        kws = json.loads(content)
        return [str(k).strip() for k in kws if str(k).strip()]
    except Exception as e:
        print(f"[AI] sinh keyword lỗi: {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
def load_registered(path):
    """Đọc registered.json (helper node xuất). Trả set username (lowercase, no @)."""
    if not path or not os.path.exists(path):
        return set()
    try:
        with open(path) as f:
            data = json.load(f)
        return {u.lower().lstrip("@") for u in data.get("usernames", [])}
    except Exception as e:
        print(f"[reg] đọc {path} lỗi: {e}", file=sys.stderr)
        return set()


async def search_bots(client, keyword, limit=SEARCH_LIMIT):
    """contacts.search → list bot dicts. Tự lùi khi FloodWait."""
    try:
        res = await client(functions.contacts.SearchRequest(q=keyword, limit=limit))
    except FloodWaitError as e:
        print(f"[!] FloodWait {e.seconds}s tại '{keyword}' — nghỉ rồi thử lại", file=sys.stderr)
        await asyncio.sleep(e.seconds + 1)
        res = await client(functions.contacts.SearchRequest(q=keyword, limit=limit))
    bots = []
    for u in res.users:
        if getattr(u, "bot", False) and u.username:
            bots.append({"username": u.username.lower(), "name": (u.first_name or "").strip(), "id": u.id})
    groups = [c for c in res.chats if isinstance(c, (Channel, Chat))]
    return bots, groups


async def scan_group_members(client, group, max_members=200):
    """Quét member 1 group, lọc ra bot. Fail-soft trả []."""
    bots = []
    try:
        async for user in client.iter_participants(group, limit=max_members):
            if getattr(user, "bot", False) and user.username:
                bots.append({"username": user.username.lower(), "name": (user.first_name or "").strip(), "id": user.id})
    except Exception as e:
        print(f"[group] quét '{getattr(group,'title','?')}' lỗi: {e}", file=sys.stderr)
    return bots


# ---------------------------------------------------------------------------
async def run(args):
    registered = load_registered(args.registered)
    print(f"[reg] {len(registered)} bot đã đăng ký được nạp để đánh dấu/lọc")

    seen = {}            # username -> dict
    tried_keywords = set()
    pending = [k.strip() for k in args.keywords.split(",") if k.strip()]

    api_id = int(os.environ["TG_API_ID"])
    api_hash = os.environ["TG_API_HASH"]

    ai_on = bool(args.ai_rounds and args.router_key)
    if args.ai_rounds and not args.router_key:
        print("[AI] --ai-rounds > 0 nhưng thiếu --router-key → bỏ qua phần AI", file=sys.stderr)

    async with TelegramClient(args.session, api_id, api_hash) as client:
        joins_done = 0
        round_no = 0
        candidate_groups = []

        while True:
            round_no += 1
            # Hết keyword pending → nhờ AI sinh thêm (nếu còn vòng AI)
            if not pending:
                if ai_on and round_no <= args.ai_rounds + 1:
                    new_kws = ai_generate_keywords(
                        args.router_url, args.router_key, args.model,
                        args.keywords, tried_keywords, len(seen),
                    )
                    new_kws = [k for k in new_kws if k.lower() not in {t.lower() for t in tried_keywords}]
                    if not new_kws:
                        print("[AI] không sinh thêm keyword mới → dừng", file=sys.stderr)
                        break
                    print(f"[AI vòng {round_no}] +{len(new_kws)} keyword: {new_kws}")
                    pending.extend(new_kws)
                else:
                    break

            kw = pending.pop(0)
            if kw.lower() in {t.lower() for t in tried_keywords}:
                continue
            tried_keywords.add(kw)

            bots, groups = await search_bots(client, kw)
            new_in_kw = 0
            for b in bots:
                if b["username"] in seen:
                    continue
                b["registered"] = b["username"] in registered
                b["via"] = f"search:{kw}"
                seen[b["username"]] = b
                new_in_kw += 1
            candidate_groups.extend(groups)
            print(f"=== '{kw}' → {len(bots)} bot ({new_in_kw} mới) | {len(groups)} group ===")
            await asyncio.sleep(SEARCH_DELAY_SEC)

        # --- (tùy chọn) join group + quét member ---
        if args.join_groups and candidate_groups:
            print(f"\n[group] ⚠️ join tối đa {args.max_joins} group để quét member (rủi ro ban)")
            uniq_groups = {getattr(g, "id", i): g for i, g in enumerate(candidate_groups)}.values()
            for g in uniq_groups:
                if joins_done >= args.max_joins:
                    break
                title = getattr(g, "title", "?")
                try:
                    await client(functions.channels.JoinChannelRequest(g))
                    joins_done += 1
                    print(f"[group] đã join '{title}' ({joins_done}/{args.max_joins})")
                    await asyncio.sleep(5)
                    members = await scan_group_members(client, g, args.max_members)
                    new_m = 0
                    for b in members:
                        if b["username"] in seen:
                            continue
                        b["registered"] = b["username"] in registered
                        b["via"] = f"group:{title}"
                        seen[b["username"]] = b
                        new_m += 1
                    print(f"[group] '{title}' → {len(members)} bot ({new_m} mới)")
                except FloodWaitError as e:
                    print(f"[group] FloodWait {e.seconds}s — dừng join", file=sys.stderr)
                    break
                except Exception as e:
                    print(f"[group] join '{title}' lỗi: {e}", file=sys.stderr)
                await asyncio.sleep(JOIN_DELAY_SEC)

    # --- output ---
    results = list(seen.values())
    if args.hide_registered:
        results = [b for b in results if not b["registered"]]

    print(f"\n=== TỔNG: {len(results)} bot " + ("(đã ẩn bot đăng ký)" if args.hide_registered else "") + " ===")
    for b in sorted(results, key=lambda x: (x["registered"], x["username"])):
        note = " [ĐÃ ĐĂNG KÝ]" if b["registered"] else ""
        print(f"  @{b['username']:<28} {b['name'][:30]:<30} {b['via']}{note}")

    if args.out:
        with open(args.out, "w") as f:
            json.dump({"count": len(results), "bots": results, "tried_keywords": sorted(tried_keywords)}, f, ensure_ascii=False, indent=2)
        print(f"\n[out] ghi {len(results)} bot → {args.out}")

    # Dòng gom username chưa đăng ký để dán vào config supplier source
    fresh = [b["username"] for b in results if not b["registered"]]
    print("\n[dán vào config] " + ",".join(f"@{u}" for u in fresh))


def parse_args():
    p = argparse.ArgumentParser(description="Tìm bot Telegram theo keyword cho 9router")
    p.add_argument("keywords", nargs="?", default="", help="keyword gốc, cách nhau dấu phẩy")
    p.add_argument("--session", default="find_bots", help="tên file session telethon")
    p.add_argument("--registered", default="registered.json", help="file bot đã đăng ký (node helper xuất)")
    p.add_argument("--hide-registered", action="store_true", help="ẩn hẳn bot đã đăng ký khỏi kết quả")
    p.add_argument("--out", default=None, help="ghi kết quả ra file JSON")
    # AI
    p.add_argument("--ai-rounds", type=int, default=0, help="số vòng AI sinh keyword (0=tắt)")
    p.add_argument("--router-url", default=os.environ.get("ROUTER_URL", "https://router.chainlens.net"))
    p.add_argument("--router-key", default=os.environ.get("ROUTER_KEY", ""), help="Bearer key 9router")
    p.add_argument("--model", default=os.environ.get("ROUTER_MODEL", "kiro/auto"))
    # group join (mặc định tắt — rủi ro ban)
    p.add_argument("--join-groups", action="store_true", help="⚠️ tự join group quét member (rủi ro ban account)")
    p.add_argument("--max-joins", type=int, default=DEFAULT_MAX_JOINS)
    p.add_argument("--max-members", type=int, default=200)
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if not args.keywords:
        raw = input("Nhập keyword gốc (cách nhau bằng dấu phẩy): ").strip()
        args.keywords = raw
    if not args.keywords.strip():
        print("Chưa nhập keyword nào.", file=sys.stderr)
        sys.exit(1)
    asyncio.run(run(args))
