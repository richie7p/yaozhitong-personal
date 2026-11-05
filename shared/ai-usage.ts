export interface AiUsage {
  date: string;
  timezone: "Asia/Taipei";
  resetsAt: string;
  checkedAt: string;
  personal: { used: number; limit: number; remaining: number };
  global: { used: number; limit: number; remaining: number };
  available: number;
  access: "ready" | "email_unverified" | "not_eligible" | "not_configured";
}
