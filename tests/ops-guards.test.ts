import { describe, expect, it } from "vitest";
import {
  validateRestorePlan,
  verifyRestorePreflight,
  validateSilentPolicies,
  planPolicyCreates,
  verifySilentPolicyReadback,
  exceedsForSamples,
  type RestorePlan,
  type OperationalPolicy,
} from "../tools/ops-guards.js";
const project = "project-example-12345",
  uid = "08b7115e-4607-44a4-8d9a-76c1e05a7b40";
const plan: RestorePlan = {
  project,
  region: "asia-east1",
  sourceDatabase: `projects/${project}/databases/(default)`,
  sourceDatabaseUid: uid,
  sourceBackup: `projects/${project}/locations/asia-east1/backups/3adc396f-d7d9-42b9-b67f-ec4df015adcc`,
  targetDatabase: `projects/${project}/databases/restore-drill-example-01`,
  limits: { restoreRequests: 1, documentReadsUpper: 50000, targetHours: 2 },
};
const source = { name: plan.sourceDatabase, uid, locationId: plan.region };
const backup = {
  name: plan.sourceBackup,
  database: plan.sourceDatabase,
  databaseUid: uid,
  state: "READY",
  expireTime: "2030-01-01T00:00:00Z",
};
const policies: OperationalPolicy[] = ["web", "worker", "queue"].map(
  (displayName) => ({
    displayName,
    enabled: true,
    notificationChannels: [],
    conditions: [{}],
  }),
);
describe("isolated restore operational guards", () => {
  it("accepts an absent named drill in the matching source location", () =>
    expect(verifyRestorePreflight(plan, source, backup, null, 0)).toEqual({
      databaseId: "restore-drill-example-01",
      backup: plan.sourceBackup,
    }));
  it.each([
    "(default)",
    "production",
    "restore-drill-../../default",
    "restore-drill-",
    "restore-drill-okay/other",
  ])("rejects destination %s", (id) =>
    expect(() =>
      validateRestorePlan({
        ...plan,
        targetDatabase: `projects/${project}/databases/${id}`,
      }),
    ).toThrow(),
  );
  it("rejects another project's backup", () =>
    expect(() =>
      validateRestorePlan({
        ...plan,
        sourceBackup: plan.sourceBackup.replace(project, "other-project"),
      }),
    ).toThrow());
  it("rejects another location's backup", () =>
    expect(() =>
      validateRestorePlan({
        ...plan,
        sourceBackup: plan.sourceBackup.replace("asia-east1", "us-east1"),
      }),
    ).toThrow());
  it("rejects an existing destination even if it is a drill", () =>
    expect(() =>
      verifyRestorePreflight(plan, source, backup, {
        ...source,
        name: plan.targetDatabase,
      }),
    ).toThrow("destination_exists"));
  it("rejects source replacement UID", () =>
    expect(() =>
      verifyRestorePreflight(
        plan,
        { ...source, uid: "replacement" },
        backup,
        null,
      ),
    ).toThrow());
  it("rejects backup pointing to another source UID", () =>
    expect(() =>
      verifyRestorePreflight(
        plan,
        source,
        { ...backup, databaseUid: "other" },
        null,
      ),
    ).toThrow());
  it.each(["CREATING", "NOT_AVAILABLE"])("rejects %s backup", (state) =>
    expect(() =>
      verifyRestorePreflight(plan, source, { ...backup, state }, null),
    ).toThrow(),
  );
  it("rejects expired backup", () =>
    expect(() =>
      verifyRestorePreflight(
        plan,
        source,
        { ...backup, expireTime: "2000-01-01T00:00:00Z" },
        null,
      ),
    ).toThrow());
  it.each([
    { restoreRequests: 2 },
    { documentReadsUpper: 50001 },
    { targetHours: 3 },
  ])("rejects excess operational budget %j", (change) =>
    expect(() =>
      validateRestorePlan({ ...plan, limits: { ...plan.limits, ...change } }),
    ).toThrow(),
  );
});
describe("silent alert rule guards and threshold intent", () => {
  it("permits the three enabled channel-less rules", () =>
    expect(validateSilentPolicies(policies)).toHaveLength(3));
  it("rejects a notification channel", () =>
    expect(() =>
      validateSilentPolicies([
        { ...policies[0], notificationChannels: ["unexpected"] },
        ...policies.slice(1),
      ]),
    ).toThrow());
  it("rejects disabled rules", () =>
    expect(() =>
      validateSilentPolicies([
        { ...policies[0], enabled: false },
        ...policies.slice(1),
      ]),
    ).toThrow());
  it("preserves existing unrelated policies", () =>
    expect(
      planPolicyCreates(policies, [
        { ...policies[0], displayName: "someone-else" },
      ]),
    ).toHaveLength(3));
  it("does not overwrite or duplicate another operator's same-name rule", () =>
    expect(() => planPolicyCreates(policies, [policies[0]])).toThrow());
  it("accepts exact condition readback with server-assigned names", () =>
    expect(
      verifySilentPolicyReadback(policies[0], {
        ...policies[0],
        conditions: [{ name: "server-assigned" }],
      }),
    ).toBe(true));
  it("rejects a changed threshold in readback", () =>
    expect(() =>
      verifySilentPolicyReadback(
        {
          ...policies[0],
          conditions: [{ conditionThreshold: { thresholdValue: 4 } }],
        },
        {
          ...policies[0],
          conditions: [{ conditionThreshold: { thresholdValue: 40 } }],
        },
      ),
    ).toThrow());
  it("rejects a newly attached channel in readback", () =>
    expect(() =>
      verifySilentPolicyReadback(policies[0], {
        ...policies[0],
        notificationChannels: ["unexpected"],
      }),
    ).toThrow());
  it("does not trigger queue at equality or for nine minutes", () => {
    expect(exceedsForSamples(Array(10).fill(10), 10, 10)).toBe(false);
    expect(exceedsForSamples(Array(9).fill(11), 10, 10)).toBe(false);
  });
  it("triggers sustained queue backlog and clears after recovery", () => {
    expect(exceedsForSamples(Array(10).fill(11), 10, 10)).toBe(true);
    expect(exceedsForSamples(Array(10).fill(0), 10, 10)).toBe(false);
  });
  it("resets sustained breach on a normal sample", () =>
    expect(exceedsForSamples([...Array(9).fill(11), 0, 11], 10, 10)).toBe(
      false,
    ));
});
