import { useId } from "react";

/** Decorative artwork: deliberately contains no example drug or dosage data. */
export function CareIllustration({ compact = false }: { compact?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={"care-illustration" + (compact ? " is-compact" : "")}
      viewBox="0 0 480 350"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id={id + "shadow"} x="-30%" y="-30%" width="170%" height="180%">
          <feDropShadow
            dx="0"
            dy="12"
            stdDeviation="12"
            floodColor="#254C3E"
            floodOpacity=".12"
          />
        </filter>
        <linearGradient
          id={id + "paper"}
          x1="145"
          y1="65"
          x2="310"
          y2="310"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFFFFC" />
          <stop offset="1" stopColor="#F0EEE5" />
        </linearGradient>
      </defs>
      <ellipse
        cx="248"
        cy="309"
        rx="155"
        ry="15"
        fill="#254C3E"
        opacity=".07"
      />
      <circle cx="250" cy="171" r="137" fill="#DAE5CD" />
      <circle
        cx="250"
        cy="171"
        r="157"
        stroke="#C2D3B6"
        strokeDasharray="2 8"
      />
      <path
        d="M99 274C70 231 68 205 80 170M88 229C62 228 50 210 51 191C73 192 86 205 88 229ZM81 203C91 183 109 176 124 180C119 198 104 207 81 203Z"
        stroke="#7F9E78"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M390 269C413 240 417 214 411 189M402 242C420 241 435 226 436 210C418 212 408 222 402 242Z"
        stroke="#7F9E78"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g transform="rotate(12 331 178)" filter={"url(#" + id + "shadow)"}>
        <rect x="296" y="96" width="92" height="155" rx="25" fill="#55775A" />
        <rect x="311" y="80" width="62" height="31" rx="8" fill="#FCFBF3" />
        <path
          d="M322 84V105M333 84V105M344 84V105M355 84V105M366 84V105"
          stroke="#D8DFCF"
          strokeWidth="2"
        />
        <rect x="296" y="142" width="92" height="64" fill="#E6EBD8" />
        <path
          d="M337 158V188M322 173H352"
          stroke="#55775A"
          strokeWidth="5"
          strokeLinecap="round"
        />
      </g>
      <g transform="rotate(-9 223 176)" filter={"url(#" + id + "shadow)"}>
        <path
          d="M137 59H302L315 291C315 300 310 305 301 305H139C130 305 125 300 125 291L137 59Z"
          fill={"url(#" + id + "paper)"}
          stroke="#D5DDCB"
        />
        <path d="M137 59H302L304 81H135L137 59Z" fill="#E8EDDF" />
        <path d="M137 86H304" stroke="#C4D3B8" />
        <rect x="151" y="106" width="32" height="32" rx="10" fill="#275B43" />
        <path
          d="M167 114V130M159 122H175"
          stroke="#FFFFF8"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <text
          x="194"
          y="127"
          fill="#294F3B"
          fontSize="19"
          fontWeight="700"
          fontFamily="Microsoft JhengHei, sans-serif"
        >
          藥袋資料
        </text>
        <path d="M151 154H286" stroke="#D6DDCE" />
        <text
          x="151"
          y="180"
          fill="#697E67"
          fontSize="12"
          fontFamily="Microsoft JhengHei, sans-serif"
        >
          藥名與用法，逐項確認
        </text>
        <rect x="151" y="196" width="134" height="59" rx="5" fill="#EDF0E5" />
        <path
          d="M163 213H213M163 236H248M232 213H271"
          stroke="#ACBBA0"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path d="M151 276H199M242 276H284" stroke="#C9D2C0" strokeWidth="2" />
      </g>
      <g transform="rotate(27 139 284)" filter={"url(#" + id + "shadow)"}>
        <rect x="98" y="267" width="84" height="34" rx="17" fill="#F7F1D9" />
        <path d="M140 267H165A17 17 0 0 1 165 301H140V267Z" fill="#DDA16E" />
        <path
          d="M109 277H127"
          stroke="#FFFDF4"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </g>
      <g filter={"url(#" + id + "shadow)"}>
        <circle cx="326" cy="267" r="35" fill="#FCFCF5" />
        <circle cx="326" cy="267" r="26" fill="#285B43" />
        <path
          d="M314 266L323 275L338 259"
          stroke="#EAF1D9"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <path
        d="M374 57V73M366 65H382M92 115V125M87 120H97"
        stroke="#A6AF86"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
