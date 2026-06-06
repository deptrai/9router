/**
 * Normalize model name: chuẩn hóa version separators để match across providers.
 * cc dùng dash (claude-opus-4-8), kr dùng dot (claude-opus-4.8).
 * Normalize: thay version dashes thành dots (e.g. "4-8" → "4.8").
 */
export function normalizeModelName(model) {
  if (!model || model === "*") return model;
  return model.replace(/(\d)-(\d)/g, "$1.$2");
}
