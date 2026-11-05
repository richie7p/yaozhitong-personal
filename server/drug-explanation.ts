import type { Llm } from "./ai.js";
import { assisted } from "./assistance.js";
import { ASSISTANCE_VERSION } from "../shared/assistance.js";
import {
  DRUG_EXPLANATION_VERSION,
  type DrugExplanationResult,
  type DrugQuery,
  type ReferenceProduct,
  type DrugCatalogReference,
} from "../shared/drug-explanation.js";
import type { Drug, Medication } from "../shared/schema.js";

export function usefulDrugQuery(query: DrugQuery) {
  const name = query.name.normalize("NFKC").replace(/\s/gu, "");
  return /[\p{L}\p{N}]/u.test(name) &&
    !/^(?:不知道|不清楚|未知|無法辨識|不明藥品|藥品|藥物|藥|藥膏|乳膏|感冒|感冒藥|止痛藥|白色藥丸|白色藥錠|白色藥片|藥丸|藥錠|藥片|unknown|medicine|medication|cream|ointment)$/iu.test(name);
}

/** The source query is never a saved medication or a personal prescription. */
export async function explainDrug(
  llm: Llm,
  query: DrugQuery,
  verifiedDrug: Drug | null = null,
  catalogReference: DrugCatalogReference | null = null,
): Promise<DrugExplanationResult> {
  const checkedAt = new Date().toISOString();
  const metadata = {
    mode: "general_information" as const,
    explanationVersion: DRUG_EXPLANATION_VERSION as typeof DRUG_EXPLANATION_VERSION,
    queriedProduct: query,
    identityStatus: verifiedDrug ? "confirmed" as const : "unverified" as const,
    ...(!verifiedDrug && catalogReference ? { catalogReference } : {}),
  };
  const identityNotice = verifiedDrug
    ? "這是一般藥品資訊，不會建立用藥檔案，也不能用來推算你的個人用量、使用次數或療程。"
    : "產品尚未核對。以下只依照片辨識或你輸入的藥名查找一般資料，不能確認就是手上的產品；請對照名稱、成分、濃度及劑型。不同產品的資料不能直接當作本品仿單或個人用藥指示。";
  if (!usefulDrugQuery(query)) return {
    ...metadata,
    status: "insufficient_data", claims: [], chunks: [], quiz: [], followups: [],
    rejectedCount: 0, sourceVersions: {}, verification: "model_assisted",
    assistance: {
      version: ASSISTANCE_VERSION, checkedAt,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      searchState: "not_found", missingLicenses: [], sources: [], claims: [],
      uncertainties: [identityNotice, "目前的文字不足以知道要查哪一款藥。請補拍有完整藥名的包裝，或輸入藥名；不需要先填個人用量或使用次數。"],
    },
  };
  const product: ReferenceProduct = verifiedDrug
    ? { ...verifiedDrug, identityVerified: true }
    : catalogReference ? {
      licenseNo: catalogReference.licenseNo, nameZh: catalogReference.nameZh,
      nameEn: catalogReference.nameEn, strength: catalogReference.strength,
      form: catalogReference.form, ingredients: [...catalogReference.ingredients],
      revoked: false, identityVerified: false, queriedName: query.name, catalogReference,
    }
    : {
      licenseNo: query.licenseNo || "", nameZh: query.name, nameEn: "",
      strength: query.strength, form: query.form, ingredients: [], revoked: false,
      identityVerified: false,
    };
  // Deliberately construct only public product fields. No stored dose, profile,
  // photo raw text, account identifier or candidate ingredient crosses this boundary.
  const medication: Medication = {
    id: "general-query", ownerId: "", name: query.name,
    licenseNo: product.licenseNo, strength: query.strength, form: query.form,
    doseAmount: null, doseUnit: "", frequencyRaw: "", route: "", rawText: "",
    durationDays: null, instructions: "", confirmed: false, prn: false,
    revision: 1, archived: false, createdAt: checkedAt, updatedAt: checkedAt,
  };
  const result = await assisted(
    llm,
    "請查詢這個藥名的基本資訊，用易懂繁體中文整理一般用途、使用注意、常見副作用與需要求助的警訊、保存方式。只列來源明確支持的部分，保留適用條件；不要推算或建議個人用量、頻次、療程、停藥或替代治療。產品未核對時須明確說明，不能把查詢名稱當成已確認的產品。",
    [medication], [product], [null],
  );
  if (result.assistance) {
    // This route always uses general reference information, even if a local
    // leaflet is later published. It must not masquerade as leaflet verification.
    result.assistance.missingLicenses = [];
    result.assistance.uncertainties = [identityNotice,
      ...(!verifiedDrug && catalogReference ? [
        `查詢文字唯一對應到目前官方登記資料「${catalogReference.nameZh}」（${catalogReference.licenseNo}）。此對應只用於查找該登記成分的一般衛教，尚未核對手上包裝，也不代表你適合使用。`,
      ] : []),
      ...result.assistance.uncertainties.filter((s) => !s.includes("本站尚未收錄可用的官方仿單")),
    ];
  }
  return { ...result, ...metadata };
}
