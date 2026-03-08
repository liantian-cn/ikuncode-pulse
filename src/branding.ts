export interface BrandingConfig {
  packageName: string;
  displayName: string;
  description: string;
  defaultBaseApiUrl: string;
  defaultSiteName: string;
  defaultSiteUrl: string;
}

const branding: BrandingConfig = {
  "packageName": "ikuncode-pulse",
  "displayName": "IkunCode Pulse",
  "description": "在 VS Code 状态栏显示 AI 余额与会话花费。",
  "defaultBaseApiUrl": "https://api.ikuncode.cc/api/",
  "defaultSiteName": "IkunCode",
  "defaultSiteUrl": "https://api.ikuncode.cc/"
};

export default branding;
