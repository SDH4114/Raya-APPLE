export const siteConfig = {
  name: "Raya",
  description: "An open-source personal AI agent harness that learns, improves with your direction, and adapts to your workflow on Windows, macOS, and Linux.",
  url: "https://sdh4114.github.io/Raya-APPLE",
  github: "https://github.com/SDH4114/Raya-APPLE",
  issues: "https://github.com/SDH4114/Raya-APPLE/issues",
  license: "https://github.com/SDH4114/Raya-APPLE/blob/prime/LICENSE",
  installScript: "https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.sh",
  installCommand: "curl -fsSL https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.sh -o /tmp/raya-install.sh && bash /tmp/raya-install.sh",
  windowsInstallScript: "https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.ps1",
  windowsInstallCommand: "$p = Join-Path $env:TEMP 'raya-install.ps1'; irm https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.ps1 -OutFile $p; & $p",
  telegram: null,
  telegramChannel: "https://t.me/BreakRulesStudio"
} as const;

export const withBasePath = (path: string): string => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
