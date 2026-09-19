export const BASE_URL = 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/';
export const APP_URL = new URL('index.do#/sportVenue', BASE_URL).href;
export const DEFAULT_SESSION_FILE = '.session.json';
export const DEFAULT_CONFIG_FILE = 'config.yaml';

export const MODE_CODES = Object.freeze({
  包场: '1.0',
  散场: '2.0',
  '1.0': '1.0',
  '2.0': '2.0',
});
