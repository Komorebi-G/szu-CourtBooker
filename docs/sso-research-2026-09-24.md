# 场馆会话与统一认证：2026-09-24 只读验证

本次在 Windows Edge 的学校登录页面完成一次人工认证。后续测试使用临时浏览器上下文，只访问学校登录页、场馆首页、身份首页和日期列表；没有提交、取消预约。记录仅包含域名、路径、状态码、Cookie 名称/属性，以及一次实验内用于比较是否变化的临时标记；没有把 Cookie 值写入仓库。

## 实测结果

| 临时上下文起始状态 | 打开场馆预约页后的结果 |
| --- | --- |
| 没有学校 Cookie | 场馆页 302 跳至 `authserver.szu.edu.cn/authserver/login`，停在登录页 |
| 仅有统一认证域的 `CASTGC` | 自动经过统一认证返回场馆页，获得新的 `MOD_AUTH_CAS` 与 `_WEU` |
| 已失效的旧场馆 Cookie + 当前 `CASTGC` | 旧场馆会话先被拒绝，随后统一认证自动签发新的场馆会话 |
| 当前统一认证域的全部 Cookie | 同样自动进入场馆页 |

在临时上下文里，已登录场馆的 `index.do` 和只读日期接口 `sportVenue/getRqList.do` 都以 `Set-Cookie` 更新 `_WEU`；前后值发生变化。`MOD_AUTH_CAS` 则在统一认证返回场馆页时重新设置。当前 `CASTGC` 的浏览器到期时间有限；重复进入场馆页并没有把这个时间向后延长。

这解释了“已登录校园门户，进入场馆无需重新输入密码”：浏览器持有的统一认证会话可以为场馆重新建立应用会话。场馆接口收到的是 `ehall.szu.edu.cn` 的 Cookie；网络接入状态本身不是场馆 Cookie。它也解释了固定场馆 Cookie 实验与浏览器体验的差异：固定快照缺少浏览器的统一认证跳转，因而无法在过期后自愈。

`Set-Cookie` 是服务端让浏览器保存、替换或删除某个 Cookie 的响应头，不是“允许客户端自行延长有效期”的授权。即使 `_WEU` 在只读请求中变化，也不能推出 `MOD_AUTH_CAS` 或统一认证会话会永久有效。浏览器显示的到期时间也不能证明服务端会接受到那一天；具体服务端空闲时限和绝对时限尚未测得。

## 本次实现

- 桌面端只在场馆身份检查失败时，尝试通过专用浏览器中的 `CASTGC` 建立新场馆会话；新会话先验证学校身份和只读日期接口，身份与账号绑定一致后才保存。
- 倒计时结束前的身份复验也能恢复同一账号的场馆会话。预约提交请求不会因登录跳转而自动重发。
- Android 学校登录窗口保留自己的统一认证会话；用户点验证或确认执行时若场馆会话失效，会打开该窗口尝试恢复。统一认证失效、换号或取消时仍需人工处理。

参考：[学校统一认证登录页](https://authserver.szu.edu.cn/authserver/login?service=https%3A%2F%2Fehall.szu.edu.cn%3A443%2Fnew%2F)、[Apereo CAS 协议](https://apereo.github.io/cas/development/protocol/CAS-Protocol-Specification.html)、[Set-Cookie 定义](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。
