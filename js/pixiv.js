/*
 * Pixiv 会员（移除广告）
 * 由 Loon/pixiv.js 移植，逻辑不变：将接口返回中的 is_premium 改为 true
 */

var body = $response.body;

// 可移除广告
body = body.replace(/\"is_premium\":\s*false/g, '"is_premium":true');

$done({ body });
