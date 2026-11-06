/**
 * Turns any way of writing a Jordanian mobile number (07…, 7…, 962…, +962…, 00962…, with spaces/dashes,
 * Arabic-Indic or Persian digits) into E.164 "+9627XXXXXXXX". Returns null if it is not a Jordanian mobile number.
 */
export function normalizeJordanMobile(raw: string): string | null {
  let d = raw
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("962")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^7[5789]\d{7}$/.test(d) ? `+962${d}` : null;
}
