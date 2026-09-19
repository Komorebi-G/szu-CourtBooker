import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SzuVenueApi } from '../shared/api.js';
import { DEFAULT_SESSION_FILE } from '../shared/constants.js';
import { HttpClient } from '../desktop/src/http-client.js';
import { importSessionFromCurl } from '../desktop/src/session.js';

console.log('请在任意浏览器中登录场馆预约网站，然后打开开发者工具的“网络/Network”。');
console.log('刷新页面，选中 ehall.szu.edu.cn 下任意成功请求，选择“复制为 cURL (bash)”。');
console.log('下面粘贴的内容只在本机解析，不会上传；Cookie 文件也已被 Git 忽略。');

const readline = createInterface({ input: stdin, output: stdout });
const curlText = await readline.question('粘贴一行 cURL 后按回车：\n> ');
readline.close();

await importSessionFromCurl(curlText, DEFAULT_SESSION_FILE);
const client = await HttpClient.create({ sessionPath: DEFAULT_SESSION_FILE });
const api = new SzuVenueApi(client);
const identity = await api.getIdentity();
await api.getAvailableDates();
await client.flush();
console.log(`登录态验证成功，当前用户：${identity.name}`);
