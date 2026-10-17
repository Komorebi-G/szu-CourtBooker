export function browserCdpPort(browser = 'edge', platform = process.platform, isWsl = Boolean(process.env.WSL_DISTRO_NAME)) {
  if (browser === 'edge') return 9335;
  return { chrome: 9336, brave: 9337, chromium: 9338 }[browser];
}
