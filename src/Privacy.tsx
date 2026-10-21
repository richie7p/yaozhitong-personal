import { useEffect, useRef } from "react";
import { useAuth } from "./auth";
import { SectionTitle } from "./components";

export function PrivacyLink() {
  return <a className="text-link" href="#privacy">資料使用與隱私</a>;
}

export function PrivacyPage() {
  const { config } = useAuth();
  const heading = useRef<HTMLElement>(null);
  useEffect(() => {
    const title = heading.current?.querySelector<HTMLElement>("h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }, []);
  return (
    <main className="public-info" id="main" ref={heading}>
      <a className="brand" href="#home">
        <img src="/icon.svg" alt="" />
        <div>藥智通<small>回到用藥手帳</small></div>
      </a>
      <SectionTitle eyebrow="使用前，先了解" title="資料使用與隱私">
        你的藥袋、提問與健康資料如何處理，以及你可以怎麼管理。
      </SectionTitle>
      <p className="fine">更新日期：2026 年 10 月 21 日</p>
      <section className="card">
        <h2>目前的服務範圍</h2>
        <p>藥智通目前提供受控試用。註冊與信箱驗證完成後，仍需取得 AI 試用資格；可到「帳號與設定」查看狀態與用量。</p>
        <p>系統協助閱讀官方仿單與確認理解，不替你診斷、開藥、決定停藥或調整劑量。沒有可確認來源的內容會顯示資料不足；請保留並對照原本的藥袋與仿單。</p>
      </section>
      <section className="card">
        <h2>會處理哪些資料</h2>
        <ul>
          <li>登入所需的帳號識別、信箱與顯示名稱；雲端登入由 Firebase Authentication 處理。</li>
          <li>你保存的藥品、用法、提醒、服藥紀錄，以及自行填寫的健康條件。</li>
          <li>上傳的藥袋圖片、用藥提問、AI 整理結果與測驗答案。</li>
          <li>啟用推播時的裝置識別，以及維護服務所需的工作狀態、用量與錯誤紀錄。</li>
        </ul>
        <p>雲端版的資料存於 Google Cloud。本機版主要資料保存在該電腦；使用 AI 功能時仍會連線至供應商。</p>
      </section>
      <section className="card">
        <h2>使用 AI 時，資料會送到哪裡</h2>
        <p>使用辨識、仿單說明或問答時，相關圖片、藥品、提問及必要健康條件會送交設定的 AI 供應商處理。請先遮住姓名、身分證號、地址及條碼中的個人識別資訊，也不要在問題中加入這些資料。照片可能另含拍攝時間、位置等隱藏資訊，請在上傳前一併移除。</p>
        {config?.aiProvider && <p>目前此版本設定的供應商：<strong>{config.aiProviderLabel || config.aiProvider}</strong>。</p>}
        <p>使用 OpenAI 的雲端版本會關閉應用程式回應儲存；這不等於供應商完全不保留資料。OpenAI 的預設濫用監控紀錄可能保留最多 30 天，另有官方列明的例外與帳戶設定；細節請閱讀 <a className="text-link" href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">OpenAI 資料處理說明</a>。</p>
      </section>
      <section className="card">
        <h2>資料保存與刪除</h2>
        <p>辨識工作結束後，系統會嘗試刪除原照片。雲端尚未清除的暫存上傳另由儲存生命週期清理；這類清理並非即時完成。</p>
        <p>已保存的用藥、問答與測驗紀錄會保留供你接續使用。可在「帳號與設定」匯出資料或提出刪除帳號；刪除時先停止存取，再由背景工作清除個人資料與照護關係。備份中的資料依保留週期到期，刪除不代表所有備份同時消失。</p>
        <p>同一分頁重新整理會接續登入。共用裝置請在使用完畢後按「登出」；瀏覽器還原分頁可能延續工作階段。未送出的問題草稿不隨重新整理保存。</p>
      </section>
      <section className="card">
        <h2>由你決定的分享與權限</h2>
        <p>家人照護分享需要明確授權，可隨時撤銷；私人問答與完整健康問卷不會提供給照護者。推播需由你另外啟用，可在瀏覽器的網站權限設定關閉通知；登出時會嘗試撤銷本裝置的推播登錄。</p>
        <p>資料問題請使用取得本次試用連結時的聯絡管道。正式公開前，這裡會提供維護者的公開聯絡方式。</p>
        <a className="btn secondary" href="#profile">前往帳號與設定</a>
      </section>
      <a className="text-link" href="#home">返回藥智通</a>
    </main>
  );
}
