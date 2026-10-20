/** Display the confirmed original amount without inventing a numeric dose. */
export function doseLabel(m: {
  doseAmount?: number | null;
  doseUnit?: string | null;
  doseText?: string | null;
}) {
  return (
    m.doseText?.trim() ||
    (m.doseAmount != null ? `${m.doseAmount} ${m.doseUnit || ""}`.trim() : "")
  );
}
