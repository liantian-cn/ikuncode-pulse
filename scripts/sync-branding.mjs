import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const brandingPath = path.join(rootDir, 'branding.json');
const packageJsonPath = path.join(rootDir, 'package.json');

const branding = JSON.parse(fs.readFileSync(brandingPath, 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

packageJson.name = branding.packageName;
packageJson.displayName = branding.displayName;
packageJson.description = branding.description;

if (packageJson.contributes?.configuration) {
  packageJson.contributes.configuration.title = branding.displayName;
}

for (const command of packageJson.contributes?.commands ?? []) {
  if (typeof command.title === 'string' && command.title.includes(':')) {
    const suffix = command.title.split(':').slice(1).join(':').trim();
    command.title = `${branding.displayName}: ${suffix}`;
  }
}

const properties = packageJson.contributes?.configuration?.properties ?? {};

if (properties['ikuncode-pulse.baseApiUrl']) {
  properties['ikuncode-pulse.baseApiUrl'].default = branding.defaultBaseApiUrl;
}

if (properties['ikuncode-pulse.siteName']) {
  properties['ikuncode-pulse.siteName'].default = branding.defaultSiteName;
}

if (properties['ikuncode-pulse.siteUrl']) {
  properties['ikuncode-pulse.siteUrl'].default = branding.defaultSiteUrl;
}

fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
