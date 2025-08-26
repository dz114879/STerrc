'use strict';
const extensionName = 'kktips';

// 初始化：仅拦截并记录 HTTP 错误到控制台
jQuery(() => {
    interceptFetchErrors();
    console.log(`[${extensionName}] 仅HTTP错误记录模式已启用`);
});

// 拦截 window.fetch 的错误并记录
function interceptFetchErrors() {
    try {
        if (window.__vertin_tips_fetch_patched) return;
        const originalFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
        if (!originalFetch) return;
        window.__vertin_tips_fetch_patched = true;

        window.fetch = async function(...args) {
            const start = Date.now();
            const req = args[0] instanceof Request ? args[0] : null;
            const method = (req && req.method) || (args[1] && args[1].method) || 'GET';
            const url = req ? req.url : (typeof args[0] === 'string' ? args[0] : '');
            try {
                const res = await originalFetch(...args);
                if (!res.ok && res.status >= 400) {
                    const latency = Date.now() - start;
                    console.log(`[${extensionName}] HTTP错误: ${method} ${res.status} ${res.statusText} - ${url} (${latency}ms)`);
                }
                return res;
            } catch (err) {
                const latency = Date.now() - start;
                const message = err && err.message ? err.message : String(err);
                console.log(`[${extensionName}] 网络错误: ${method} - ${url} - ${message} (${latency}ms)`);
                showErrorOverlay(
                    '[${extensionName}] 网络错误: ' + method + ' ' + url + ' (' + latency + 'ms)\\n错误信息: ' + message,
                    extractErrorSuggestion(message)
                );
                throw err;
            }
        };
    } catch (e) {
        // 任何初始化失败均静默，不影响宿主
    }
}
// 错误关键词与建议
const errorKeywords = {
    'unauthorized': '请检查API密钥或访问权限配置',
    'forbidden': '请确认当前账户是否有权限执行此操作',
    'not found': '请求地址可能有误，请确认 URL 是否正确',
    'bad request': '请求格式可能有误，建议检查请求参数结构',
    'internal server error': '服务端出现异常，请稍后重试或联系服务提供方',
    'service unavailable': '服务暂时不可用，请稍后再试',
    'gateway timeout': '服务器响应超时，可能处于高负载状态',
    'ECONNREFUSED': '连接被拒绝，若使用了各种代理或反向代理，请检查它们是否已正确启动',
    'ETIMEDOUT': '连接超时，若正在使用Google AI Studio API，请检查是否已经开启梯子的tun模式或者为SillyTavern配置代理；若已经启用了tun模式或开启了代理，请按照更换代理节点->更换网络->更换代理服务提供商依次尝试解决',
    'ENOTFOUND': '无法解析服务器地址，请按照更换代理节点->更换网络->更换代理服务提供商依次尝试解决',
    'ECONNRESET': '连接被重置，请按照更换代理节点->更换网络->更换代理服务提供商依次尝试解决',
};

function extractErrorSuggestion(raw) {
    const lower = raw.toLowerCase();
    for (const key in errorKeywords) {
        if (lower.includes(key)) {
            return errorKeywords[key];
        }
        
        window.addEventListener('error', (ev) => {
            const msg = ev?.error?.message || ev.message || String(ev);
            showErrorOverlay(
                '[${extensionName}] 未捕获异常: ' + msg,
                extractErrorSuggestion(msg)
            );
        });
        
        window.addEventListener('unhandledrejection', (ev) => {
            const reason = ev?.reason;
            const msg = typeof reason === 'string' ? reason : (reason?.message || JSON.stringify(reason));
            showErrorOverlay(
                '[${extensionName}] Promise未处理拒绝: ' + msg,
                extractErrorSuggestion(msg)
            );
        });
    }
    return '未能识别具体问题，请参考完整错误信息或查阅文档';
}
// 弹窗组件注入逻辑
function showErrorOverlay(errorText, suggestion) {
    if (document.getElementById('__kktips_error_popup')) return;

    const container = document.createElement('div');
    container.id = '__kktips_error_popup';
    container.style.cssText = `
        position: fixed;
        top: 16px;
        right: 16px;
        width: 320px;
        z-index: 999999;
        background: #fff;
        color: #222;
        font-family: monospace;
        border: 1px solid gray;
        box-shadow: 2px 2px 10px rgba(0,0,0,0.3);
        border-radius: 8px;
        overflow: hidden;
    `;

    container.innerHTML = [
        '<div style="padding: 8px; font-weight: bold; background:#f8d7da; color:#721c24;">🚨 报错提示</div>',
        '<div style="padding: 8px; font-size: 13px; white-space: pre-wrap; max-height: 160px; overflow:auto;">' + errorText + '</div>',
        '<div style="padding: 8px; background:#fff3cd; color:#856404; font-size: 12px;">💡 可能的解决方案：' + suggestion + '</div>',
        '<div style="padding: 8px; text-align:right;">' +
            '<button id="__kktips_copy_btn" style="margin-right:10px;">复制</button>' +
            '<button onclick="this.parentNode.parentNode.remove()">关闭</button>' +
        '</div>'
    ].join('');

    document.body.appendChild(container);

    document.getElementById('__kktips_copy_btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(errorText).catch(() => {});
    });

    setTimeout(() => {
        container?.remove();
    }, 15000);
}