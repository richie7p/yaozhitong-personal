import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import { Button, Field, Notice } from "./components";

export const identityGuidance =
  "補拍完整藥名（廠牌／口味）、含量／濃度與劑型，或外盒許可證；若藥袋沒印，補拍外盒／瓶身或向原調劑院所補資料。";

export function leafletReady(m: {
  confirmed?: boolean;
  licenseNo?: string | null;
  identityReview?: { status?: string };
}) {
  return (
    m.confirmed === true &&
    !!m.licenseNo &&
    m.identityReview?.status === "confirmed"
  );
}

const emptyEvidence = {
  method: "license",
  printedLicenseNo: "",
  printedName: "",
  printedStrength: "",
  printedForm: "",
};

/** A catalog candidate is a comparison target, never evidence from the package. */
export function ProductIdentityReview({
  medication,
  onPatch,
  onRetake,
}: {
  medication: any;
  onPatch: (patch: any) => void;
  onRetake?: () => void;
}) {
  const { me } = useAuth();
  const group = useId();
  const version = useRef(0);
  const live = useRef(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const evidence = medication.identityEvidence || emptyEvidence;
  const candidate =
    medication.identityCandidate || medication.identityReview?.candidate;
  const confirmed = medication.identityReview?.status === "confirmed";
  const fingerprint = JSON.stringify([
    me?.account?.id,
    medication.name,
    medication.strength,
    medication.form,
    medication.candidateLicenseNo,
    evidence,
  ]);
  const current = useRef(fingerprint);
  current.current = fingerprint;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      version.current++;
    };
  }, []);
  // A changed product invalidates even an in-flight check. Keep the inputs usable.
  useEffect(() => {
    version.current++;
    setChecking(false);
    setError("");
  }, [fingerprint]);

  function change(patch: any) {
    version.current++;
    setChecking(false);
    setError("");
    onPatch({
      identityEvidence: patch.method
        ? { ...emptyEvidence, method: patch.method }
        : { ...evidence, ...patch },
      identityReview: null,
      licenseNo: null,
    });
  }

  async function check() {
    const requestVersion = ++version.current;
    const submitted = fingerprint;
    const assertCurrent = () => {
      if (
        !live.current ||
        current.current !== submitted ||
        version.current !== requestVersion
      )
        throw new Error("核對資料已變更，請重新核對。");
    };
    setChecking(true);
    setError("");
    try {
      const { identityReview } = await api<any>(
        "/medications/identity-check",
        "POST",
        {
          candidateLicenseNo: medication.candidateLicenseNo || null,
          identityEvidence: { ...evidence },
        },
        undefined,
        assertCurrent,
      );
      assertCurrent();
      onPatch({
        identityReview,
        licenseNo:
          identityReview.status === "confirmed"
            ? identityReview.candidate?.licenseNo || null
            : null,
        candidateLicenseNo:
          identityReview.candidate?.licenseNo ||
          medication.candidateLicenseNo ||
          null,
        identityCandidate: identityReview.candidate || candidate || null,
      });
    } catch (cause: any) {
      if (
        live.current &&
        current.current === submitted &&
        version.current === requestVersion
      )
        setError(cause.message);
    } finally {
      if (live.current && version.current === requestVersion)
        setChecking(false);
    }
  }

  return (
    <section
      className="full-grid product-identity-review"
      aria-labelledby={group}
    >
      <div className="row wrap spread">
        <h3 id={group}>核對手上產品</h3>
        <span className={"tag " + (confirmed ? "green" : "amber")}>
          {confirmed ? "產品已核對" : "產品待核對"}
        </span>
      </div>
      {candidate && (
        <div className="card small identity-candidate">
          <strong>
            {confirmed ? "核對產品：" : "待核對候選："}
            {candidate.nameZh}
          </strong>
          {candidate.nameEn && <p>{candidate.nameEn}</p>}
          <p>
            含量／規格：{candidate.strength || "官方未提供"} · 劑型：
            {candidate.form || "官方未提供"}
          </p>
          <p>候選許可證：{candidate.licenseNo}</p>
          {!confirmed && (
            <p>同名藥品可能有不同廠牌、口味或規格。選取候選尚未連結仿單。</p>
          )}
          <Button
            className="ghost"
            onClick={() => {
              version.current++;
              setChecking(false);
              setError("");
              onPatch({
                candidateLicenseNo: null,
                identityCandidate: null,
                identityReview: null,
                licenseNo: null,
                identityEvidence: null,
              });
            }}
          >
            移除候選，依包裝重新核對
          </Button>
        </div>
      )}
      <Notice>{identityGuidance}</Notice>
      <p>
        請從手上包裝另行抄錄，與候選的完整品名、含量及劑型核對。用法確認不代表產品已核對。
      </p>
      <fieldset className="identity-methods">
        <legend>選擇核對方式</legend>
        <label className="choice">
          <input
            type="radio"
            name={group}
            checked={evidence.method === "license"}
            onChange={() => change({ method: "license" })}
          />
          從包裝抄許可證
        </label>
        <label className="choice">
          <input
            type="radio"
            name={group}
            checked={evidence.method === "details"}
            onChange={() => change({ method: "details" })}
          />
          補充完整產品資料
        </label>
      </fieldset>
      {evidence.method === "license" ? (
        <Field label="包裝上的完整許可證字號">
          <input
            value={evidence.printedLicenseNo}
            maxLength={80}
            onChange={(e) => change({ printedLicenseNo: e.target.value })}
            placeholder="連同衛部／衛署等前綴照印刷內容抄錄"
          />
        </Field>
      ) : (
        <div className="form-grid">
          <Field label="包裝完整產品名稱（含廠牌／口味）">
            <input
              value={evidence.printedName}
              maxLength={150}
              onChange={(e) => change({ printedName: e.target.value })}
              placeholder="請照包裝另行抄錄完整名稱"
            />
          </Field>
          <Field label="包裝含量／濃度">
            <input
              value={evidence.printedStrength}
              maxLength={80}
              onChange={(e) => change({ printedStrength: e.target.value })}
              placeholder="例如每錠、每毫升的含量"
            />
          </Field>
          <Field label="包裝劑型">
            <input
              value={evidence.printedForm}
              maxLength={50}
              onChange={(e) => change({ printedForm: e.target.value })}
              placeholder="例如：糖漿、膜衣錠"
            />
          </Field>
        </div>
      )}
      {error && (
        <Notice error>{error} 輸入資料與用法已保留，可重試核對。</Notice>
      )}
      {medication.identityReview?.message && (
        <Notice>{medication.identityReview.message}</Notice>
      )}
      <div className="row wrap">
        <Button className="secondary" disabled={checking} onClick={check}>
          {checking ? "核對中…" : "核對產品資料"}
        </Button>
        {onRetake ? (
          <Button className="ghost" onClick={onRetake}>
            返回補拍／上傳
          </Button>
        ) : (
          <a className="btn ghost" href="#add">
            新增照片辨識／上傳
          </a>
        )}
      </div>
      <p className="fine">
        核對產品資料不會呼叫 AI，也不會扣除 AI
        額度。資料不足時可先保存待核對資料，稍後繼續。
      </p>
    </section>
  );
}
