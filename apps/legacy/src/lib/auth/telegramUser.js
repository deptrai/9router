import { getUserByTelegramId, getUserByEmail, createUser, updateUser } from "@/lib/db/repos/usersRepo.js";

export async function getOrCreateTelegramUser(telegramUser) {
  if (!telegramUser || typeof telegramUser.id !== "number" || !Number.isSafeInteger(telegramUser.id) || telegramUser.id <= 0) {
    throw new Error("Invalid telegram user");
  }
  const telegramId = String(telegramUser.id);
  let user = await getUserByTelegramId(telegramId);
  if (user) {
    if (user.telegramId !== telegramId) {
      await updateUser(user.id, { telegramId });
      user = { ...user, telegramId };
    }
    return user;
  }

  const safeString = (v) => typeof v === "string" ? v : "";
  const displayName =
    [safeString(telegramUser.first_name), safeString(telegramUser.last_name)].filter(Boolean).join(" ").trim() ||
    safeString(telegramUser.username) ||
    `tg_${telegramId}`;
  const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
  try {
    user = await createUser(placeholderEmail, null, displayName);
  } catch (createErr) {
    await new Promise((r) => setTimeout(r, 100));
    user = await getUserByTelegramId(telegramId);
    if (!user) user = await getUserByEmail(placeholderEmail);
    if (!user) throw createErr;
  }
  if (!user) {
    throw new Error("Failed to create or find telegram user");
  }
  if (user.telegramId !== telegramId) {
    await updateUser(user.id, { telegramId });
    user = { ...user, telegramId };
  }
  return user;
}
