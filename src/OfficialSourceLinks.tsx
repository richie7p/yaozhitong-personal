import type { OfficialSourceReference } from "../shared/schema";
import { officialLeafletUrl } from "../shared/official-leaflet-url";

export function OfficialSourceLinks({
  sources,
}: {
  sources: OfficialSourceReference[];
}) {
  if (!sources.length) return null;
  return (
    <details>
      <summary>查看官方仿單原文</summary>
      {sources.map((source) => {
        const url = officialLeafletUrl(source.sourceUrl);
        return (
          <div key={source.licenseNo + ":" + source.version}>
            <p>{source.licenseNo}</p>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                開啟官方仿單原文
              </a>
            ) : (
              <p>
                目前無法提供這份原文的連結，可將許可證字號提供藥師協助查閱。
              </p>
            )}
          </div>
        );
      })}
    </details>
  );
}
