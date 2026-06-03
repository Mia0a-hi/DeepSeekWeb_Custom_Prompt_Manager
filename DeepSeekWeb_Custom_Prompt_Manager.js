// ==UserScript==
// @name         DeepSeek Custom Prompt Manager
// @version      1.1.1
// @description  DeepSeek 提示词管理：修复默认专家模式逻辑及深浅色切换问题，全面兼容 DeepSeek 最新 API 结构。
// @author       Mia0a 
// @license      GPL-3.0-or-later
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    //  模块 1：状态管理
    // ==========================================
    const LS_PROMPTS_LIST = 'dse_prompts_list';
    const LS_ACTIVE_PROMPT = 'dse_active_prompt_id';
    const LS_AUTO_EXPERT = 'dse_auto_expert_enabled';

    const State = {
        prompts: [],
        activeId: '',
        autoExpert: true,

        init() {
            this.migrateLegacy();
            try {
                this.prompts = JSON.parse(localStorage.getItem(LS_PROMPTS_LIST) || '[]');
            } catch {
                this.prompts = [];
            }
            this.activeId = localStorage.getItem(LS_ACTIVE_PROMPT) || '';
            const expertVal = localStorage.getItem(LS_AUTO_EXPERT);
            this.autoExpert = expertVal === null ? true : expertVal === 'true';
        },

        save() {
            localStorage.setItem(LS_PROMPTS_LIST, JSON.stringify(this.prompts));
            if (this.activeId) localStorage.setItem(LS_ACTIVE_PROMPT, this.activeId);
            else localStorage.removeItem(LS_ACTIVE_PROMPT);
            localStorage.setItem(LS_AUTO_EXPERT, this.autoExpert);
        },

        migrateLegacy() {
            const legacy = localStorage.getItem('dse_custom_prompt');
            if (legacy) {
                let list = [];
                try { list = JSON.parse(localStorage.getItem(LS_PROMPTS_LIST) || '[]'); } catch { }
                if (list.length === 0) {
                    const newId = 'pr_' + Date.now();
                    list.push({ id: newId, title: '旧版提示词', content: legacy, includeTime: false });
                    localStorage.setItem(LS_PROMPTS_LIST, JSON.stringify(list));
                    localStorage.setItem(LS_ACTIVE_PROMPT, newId);
                }
                localStorage.removeItem('dse_custom_prompt');
            }
        }
    };

    State.init();

    // ==========================================
    //  模块 2：网络拦截
    // ==========================================
    function modifyRequest(bodyStr) {
        if (!State.activeId) return bodyStr;
        const p = State.prompts.find(x => x.id === State.activeId);
        if (!p) return bodyStr;

        const baseContent = p.content.trim();
        if (!baseContent) return bodyStr;

        let customPrompt = baseContent;
        if (p.includeTime) {
            const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
            customPrompt += `\n\n[系统附加信息：当前实时系统时间为 ${timeStr}]`;
        }

        try {
            const parsed = JSON.parse(bodyStr);
            let modified = false;

            // 处理多种可能的 prompt 字段名称 (兼容最新 API 和不同的请求结构)
            if (parsed.prompt && typeof parsed.prompt === 'string' && !parsed.prompt.startsWith(baseContent)) {
                parsed.prompt = customPrompt + '\n\n' + parsed.prompt;
                modified = true;
            }
            if (parsed.message && typeof parsed.message === 'string' && !parsed.message.startsWith(baseContent)) {
                parsed.message = customPrompt + '\n\n' + parsed.message;
                modified = true;
            }
            if (parsed.content && typeof parsed.content === 'string' && !parsed.content.startsWith(baseContent)) {
                parsed.content = customPrompt + '\n\n' + parsed.content;
                modified = true;
            }

            // 处理 messages 数组
            if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
                if (parsed.messages[0].role === 'system') {
                    if (typeof parsed.messages[0].content === 'string' && !parsed.messages[0].content.startsWith(baseContent)) {
                        parsed.messages[0].content = customPrompt + '\n\n' + parsed.messages[0].content;
                        modified = true;
                    }
                } else {
                    const firstUser = parsed.messages.find(m => m.role === 'user');
                    if (firstUser && typeof firstUser.content === 'string' && !firstUser.content.startsWith(baseContent)) {
                        parsed.messages.unshift({ role: 'system', content: customPrompt });
                        modified = true;
                    }
                }
            }

            if (modified) {
                return JSON.stringify(parsed);
            }
        } catch { /* ignored */ }
        return bodyStr;
    }

    const XHRProto = XMLHttpRequest.prototype;
    const _origOpen = XHRProto.open;
    const _origSend = XHRProto.send;
    const _xhrMeta = new WeakMap();

    XHRProto.open = function (method, url, ...rest) {
        _xhrMeta.set(this, { url: String(url) });
        return _origOpen.apply(this, [method, url, ...rest]);
    };
    XHRProto.send = function (body) {
        try {
            const meta = _xhrMeta.get(this);
            if (meta && meta.url && (meta.url.includes('completion') || meta.url.includes('chat') || meta.url.includes('message')) && body) {
                if (typeof body === 'string') {
                    body = modifyRequest(body);
                } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
                    try {
                        const text = new TextDecoder('utf-8').decode(body);
                        const newText = modifyRequest(text);
                        if (newText !== text) {
                            body = new TextEncoder().encode(newText);
                        }
                    } catch (e) { }
                }
            }
        } catch (e) {
            console.error('[DS Prompt Manager] XHR Intercept Error:', e);
        }
        return _origSend.apply(this, [body]);
    };

    const _origFetch = window.fetch;
    window.fetch = async function (...args) {
        try {
            let request = args[0];
            let options = args[1];

            let url = '';
            let body = null;
            let isRequestObj = false;

            if (request instanceof Request) {
                url = request.url;
                isRequestObj = true;
                if (!options || options.body === undefined) {
                    try {
                        const clone = request.clone();
                        body = await clone.text();
                    } catch (e) {
                        body = null;
                    }
                } else {
                    body = options.body;
                }
            } else {
                url = typeof request === 'string' ? request : (request?.url || '');
                body = options?.body;
            }

            if (url && (url.includes('completion') || url.includes('chat') || url.includes('message')) && body) {
                let textBody = null;
                let isBinary = false;

                if (typeof body === 'string') {
                    textBody = body;
                } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
                    try {
                        textBody = new TextDecoder('utf-8').decode(body);
                        isBinary = true;
                    } catch (e) { }
                }

                if (textBody) {
                    const newBody = modifyRequest(textBody);
                    if (newBody !== textBody) {
                        const finalBody = isBinary ? new TextEncoder().encode(newBody) : newBody;
                        if (isRequestObj && (!options || options.body === undefined)) {
                            // Reconstruct the Request with modified body
                            request = new Request(request, { body: finalBody });
                            args[0] = request;
                        } else if (options) {
                            options.body = finalBody;
                            args[1] = options;
                        } else {
                            args[1] = { body: finalBody };
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[DS Prompt Manager] Fetch Intercept Error:', e);
        }
        return _origFetch.apply(this, args);
    };

    // ==========================================
    //  模块 3：UI 构建与渲染
    // ==========================================
    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    function toast(msg, type = 'info') {
        const el = document.createElement('div');
        // 修复：使用无视主题的高级深色毛玻璃材质，告别原站变量变化导致的黑底黑字问题，并在亮暗模式下均具备极强质感。
        el.style.cssText = `position:fixed;top:24px;left:50%;transform:translateX(-50%) translateY(-20px) scale(0.95);z-index:1000001;background:rgba(35,35,35,0.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#ffffff;padding:12px 24px;border-radius:99px;font-size:14px;font-weight:500;box-shadow:0 12px 32px rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);font-family:inherit;transition:all 0.4s cubic-bezier(0.16, 1, 0.3, 1); opacity:0; pointer-events:none; display:flex; align-items:center; gap:8px;`;
        let icon = '';
        if (type === 'success') {
            icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--dsw-alias-state-success-primary, #22c55e)" stroke="none"><path d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10zm-.997-6l7.07-7.071-1.414-1.414-5.656 5.657-2.829-2.829-1.414 1.414L11.003 16z"/></svg>`;
        } else if (type === 'error') {
            icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--dsw-alias-state-error-primary, #ef4444)" stroke="none"><path d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10zm-1-7v2h2v-2h-2zm0-8v6h2V7h-2z"/></svg>`;
        }
        el.innerHTML = `${icon} <span>${msg}</span>`;

        document.body.appendChild(el);
        requestAnimationFrame(() => { el.style.transform = 'translateX(-50%) translateY(0) scale(1)'; el.style.opacity = '1'; });
        setTimeout(() => {
            el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(-15px) scale(0.95)';
            setTimeout(() => el.remove(), 400);
        }, 2500);
    }

    const style = document.createElement('style');
    style.textContent = `
    #dsp-modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.2); z-index: 999997; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
    #dsp-modal-overlay.open { opacity: 1; pointer-events: auto; }

    #dsp-panel { position: fixed; z-index: 999998; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95) translateY(10px); width: 480px; max-height: 85vh; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1a1a1a); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.05)); border-radius: 24px; box-shadow: 0 24px 64px rgba(0,0,0,0.1), 0 8px 24px rgba(0,0,0,0.06); font-family: inherit; display: flex; flex-direction: column; overflow: hidden; opacity: 0; pointer-events: none; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
    #dsp-panel.open { opacity: 1; transform: translate(-50%, -50%) scale(1) translateY(0); pointer-events: auto; }

    #dsp-panel .hd { padding: 22px 24px 18px; display: flex; align-items: center; justify-content: space-between; background: linear-gradient(180deg, var(--dsw-alias-interactive-bg-hover, rgba(77, 107, 254, 0.04)) 0%, transparent 100%); border-bottom: 1px solid var(--dsw-alias-border-l1); }
    #dsp-panel .hd h3 { margin: 0; font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 8px; letter-spacing: 0.3px; }
    #dsp-panel .hd .cls { background: var(--dsw-alias-interactive-bg-hover); border: none; color: var(--dsw-alias-label-secondary); font-size: 18px; cursor: pointer; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    #dsp-panel .hd .cls:hover { background: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); transform: rotate(90deg); }

    .dsp-bd { flex: 1; overflow-y: auto; padding: 20px 24px 24px; }
    .dsp-bd::-webkit-scrollbar { width: 5px; }
    .dsp-bd::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1, rgba(0,0,0,0.1)); border-radius: 10px; }

    .dsp-switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .dsp-switch input { opacity: 0; width: 0; height: 0; }
    .dsp-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--dsw-alias-border-l3, #ccc); transition: .3s cubic-bezier(0.16, 1, 0.3, 1); border-radius: 34px; }
    .dsp-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .3s cubic-bezier(0.16, 1, 0.3, 1); border-radius: 50%; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
    input:checked + .dsp-slider { background-color: var(--dsw-alias-brand-primary, #4d6bfe); }
    input:checked + .dsp-slider:before { transform: translateX(20px); }

    .dsp-setting-card { padding: 18px 20px; background: var(--dsw-alias-bg-layer-2, #fbfbfb); border: 1px solid var(--dsw-alias-border-l1); border-radius: 18px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; transition: all 0.2s; }
    .dsp-setting-card:hover { border-color: var(--dsw-alias-button-ghost-active-border); background: var(--dsw-alias-button-ghost-active-fill); }
    .dsp-setting-text { flex: 1; padding-right: 16px; }
    .dsp-setting-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 6px; }
    .dsp-setting-title svg { color: var(--dsw-alias-brand-primary); }
    .dsp-setting-desc { font-size: 12.5px; color: var(--dsw-alias-label-tertiary, #888); margin-top: 6px; line-height: 1.4; }

    .dsp-list-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .dsp-list-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 6px;}

    .dsp-btn-new { background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff; border: none; border-radius: 99px; padding: 7px 16px; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); box-shadow: 0 4px 12px rgba(77, 107, 254, 0.2); }
    .dsp-btn-new:hover { transform: translateY(-1px) scale(1.02); box-shadow: 0 6px 16px rgba(77, 107, 254, 0.3); background: var(--dsw-alias-button-primary-hover); }
    .dsp-btn-new:active { transform: translateY(1px) scale(0.98); }

    #prompt-list { display: flex; flex-direction: column; gap: 12px; }
    .dsp-prompt-item { padding: 18px; border-radius: 16px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); position: relative; }
    .dsp-prompt-item:hover { border-color: var(--dsw-alias-button-ghost-active-border, rgba(77,107,254,0.3)); box-shadow: 0 8px 24px rgba(0,0,0,0.04); transform: translateY(-2px); z-index: 2; }

    .dsp-prompt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .dsp-prompt-title { font-size: 15px; color: var(--dsw-alias-label-primary); font-weight: 600; letter-spacing: 0.2px; }
    .dsp-prompt-preview { font-size: 13.5px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5; }

    .dsp-prompt-actions { display: flex; gap: 14px; opacity: 0; transform: translateX(5px); transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
    .dsp-prompt-item:hover .dsp-prompt-actions { opacity: 1; transform: translateX(0); }
    .dsp-prompt-actions button { background: none; border: none; cursor: pointer; font-size: 13px; font-weight: 500; padding: 4px 6px; transition: all 0.2s; border-radius: 6px; }
    .dsp-prompt-actions .edit { color: var(--dsw-alias-brand-text); }
    .dsp-prompt-actions .edit:hover { background: var(--dsw-alias-button-ghost-active-fill); }
    .dsp-prompt-actions .del { color: var(--dsw-alias-state-error-primary); }
    .dsp-prompt-actions .del:hover { background: rgba(239, 68, 68, 0.1); }

    .dsp-badge-time { font-size: 11.5px; padding: 2px 8px; background: var(--dsw-alias-button-ghost-active-fill, #f0f4ff); color: var(--dsw-alias-brand-text, #4d6bfe); border-radius: 99px; margin-left: 10px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--dsw-alias-button-ghost-active-border); }

    #prompt-edit-area { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-button-ghost-active-border); padding: 22px; border-radius: 18px; margin-top: 16px; box-shadow: inset 0 2px 8px rgba(0,0,0,0.02); animation: dsp-slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
    @keyframes dsp-slide-down { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

    .dsp-input { width: 100%; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; box-sizing: border-box; outline: none; transition: all 0.2s; font-family: inherit; line-height: 1.6; }
    .dsp-input:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 4px var(--dsw-alias-button-ghost-active-fill); }
    .dsp-input::placeholder { color: var(--dsw-alias-label-tertiary); }

    .dsp-btn-pri { background: var(--dsw-alias-brand-primary); color: #fff; border: none; border-radius: 10px; cursor: pointer; font-weight: 500; transition: all 0.2s; padding: 10px 24px; font-size: 13.5px; box-shadow: 0 4px 12px rgba(77,107,254,0.2); }
    .dsp-btn-pri:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(77,107,254,0.3); }
    .dsp-btn-pri:active { transform: translateY(1px); }
    .dsp-btn-sec { background: transparent; color: var(--dsw-alias-label-secondary); border: none; border-radius: 10px; cursor: pointer; transition: all 0.2s; padding: 10px 20px; font-size: 13.5px; font-weight: 500; }
    .dsp-btn-sec:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

    /* ==============================================================
       Native Wrapper Sync
       ============================================================== */
    #dsp-native-wrapper {
        display: inline-flex; align-items: center;
        margin-left: 8px; margin-right: 4px;
        animation: dsp-fade-in 0.3s ease; height: 34px;
        flex-shrink: 0; z-index: 10;
    }
    @keyframes dsp-fade-in { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }

    .dsp-native-pill {
        display: flex; align-items: center; height: 100%; position: relative;
        background: transparent;
        border: 1px solid var(--dsw-alias-border-l2, rgba(130, 130, 150, 0.25));
        border-radius: 18px;
        transition: all 0.2s ease; box-sizing: border-box;
        color: var(--dsw-alias-label-primary, #333);
        font-size: 13px;
        padding: 0 6px 0 0;
        font-weight: 500;
        flex-shrink: 0;
    }
    .dsp-native-pill:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }
    .dsp-native-pill.active {
        color: var(--dsw-alias-brand-text, #4d6bfe) !important;
        background: var(--dsw-alias-button-ghost-active-fill, #f0f4ff) !important;
        border-color: var(--dsw-alias-button-ghost-active-border, rgba(77, 107, 254, 0.3)) !important;
    }
    .dsp-native-pill.active:hover { background: var(--dsw-alias-button-ghost-active-hover, #e6edff) !important; }

    .dsp-visual-box { display: flex; align-items: center; padding: 0 4px 0 14px; cursor: pointer; height: 100%; border-radius: 18px 0 0 18px; user-select: none; flex-shrink: 0; }
    #dsp-qs-text {
        max-width: 90px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        margin: 0 6px;
        font-weight: 500;
        letter-spacing: 0.2px;
    }
    .dsp-pill-divider { width: 1px; height: 14px; background: var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); margin: 0 2px; }

    #dsp-open-panel-btn {
        background: none; border: none; color: var(--dsw-alias-label-tertiary, #888); cursor: pointer;
        width: 24px; height: 24px;
        display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s; margin-left: 2px; z-index: 11; flex-shrink: 0;
        overflow: visible;
    }
    #dsp-open-panel-btn:hover { color: var(--dsw-alias-label-primary, #333); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); transform: rotate(15deg); }
    .dsp-native-pill.active #dsp-open-panel-btn { color: var(--dsw-alias-brand-text, #4d6bfe); }
    .dsp-native-pill.active #dsp-open-panel-btn:hover { background: var(--dsw-alias-interactive-bg-hover-accent, rgba(77, 107, 254, 0.1)); }

    /* Dropdown */
    .dsp-global-menu { position: fixed; background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff)); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.12)); min-width: 170px; max-height: 280px; overflow-y: auto; z-index: 9999999; display: none; flex-direction: column; padding: 8px; }
    .dsp-global-menu.open { display: flex; }
    .dsp-global-menu::-webkit-scrollbar { width: 4px; }
    .dsp-global-menu::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 2px; }
    @keyframes dsp-dropdown-in { from { opacity: 0; transform: scale(0.95) translateY(-8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    @keyframes dsp-dropup-in { from { opacity: 0; transform: scale(0.95) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .dsp-custom-menu-item { padding: 12px 14px; font-size: 14px; color: var(--dsw-alias-label-primary, #333); cursor: pointer; border-radius: 10px; transition: all 0.15s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; justify-content: space-between; font-weight: 500;}
    .dsp-custom-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); transform: translateX(2px); }
    .dsp-custom-menu-item.active { color: var(--dsw-alias-brand-text); background: var(--dsw-alias-button-ghost-active-fill); }
  `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'dsp-modal-overlay';
    document.body.appendChild(overlay);

    const panel = document.createElement('div');
    panel.id = 'dsp-panel';

    panel.innerHTML = `
    <div class="hd">
      <h3>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--dsw-alias-brand-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
        灵感与偏好
      </h3>
      <button class="cls">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>

    <div class="dsp-bd">
      <div class="dsp-setting-card">
        <div class="dsp-setting-text">
          <span class="dsp-setting-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            专家模式自动激活
          </span>
          <span class="dsp-setting-desc">开启后，创建新对话将默认为您点亮“专家”模式。</span>
        </div>
        <label class="dsp-switch">
          <input type="checkbox" id="dsp-auto-expert-cb">
          <span class="dsp-slider"></span>
        </label>
      </div>

      <div class="dsp-list-header">
        <span class="dsp-list-title">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
           专属指令库
        </span>
        <button id="prompt-new-btn" class="dsp-btn-new">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          新建
        </button>
      </div>

      <div id="prompt-list"></div>

      <div id="prompt-edit-area" style="display:none;">
        <input type="hidden" id="prompt-edit-id">
        <input type="text" id="prompt-edit-title" class="dsp-input" placeholder="输入一个响亮的标题，如: 🧠 量化分析引擎" style="margin-bottom:14px; font-weight: 500;">
        <textarea id="prompt-edit-content" class="dsp-input" rows="4" placeholder="在此输入你的 System Prompt..." style="resize:vertical;min-height:100px;margin-bottom:18px;"></textarea>

        <div style="display:flex; align-items:center; justify-content: space-between; margin-bottom: 24px; padding: 12px 16px; background: var(--dsw-alias-bg-base); border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1);">
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:13.5px; font-weight:600; color:var(--dsw-alias-label-primary);">动态时间注入</span>
            <span style="font-size:12px; color:var(--dsw-alias-label-tertiary);">每次发送对话时，自动追加最新的系统实时时间。</span>
          </div>
          <label class="dsp-switch">
            <input type="checkbox" id="prompt-edit-time">
            <span class="dsp-slider"></span>
          </label>
        </div>

        <div style="display:flex;gap:12px;justify-content:flex-end">
          <button id="prompt-edit-cancel" class="dsp-btn-sec">取消编辑</button>
          <button id="prompt-edit-save" class="dsp-btn-pri">保存指令</button>
        </div>
      </div>
    </div>
  `;
    document.body.appendChild(panel);

    const globalMenu = document.createElement('div');
    globalMenu.id = 'dsp-global-dropdown-menu';
    globalMenu.className = 'dsp-global-menu';
    document.body.appendChild(globalMenu);

    function togglePanel(show) {
        if (show) {
            panel.classList.add('open');
            overlay.classList.add('open');
            globalMenu.classList.remove('open');
            document.getElementById('dsp-auto-expert-cb').checked = State.autoExpert;
        } else {
            panel.classList.remove('open');
            overlay.classList.remove('open');
        }
    }

    panel.querySelector('.cls').onclick = () => togglePanel(false);
    overlay.onclick = () => togglePanel(false);

    document.getElementById('dsp-auto-expert-cb').addEventListener('change', (e) => {
        State.autoExpert = e.target.checked;
        State.save();
        toast(State.autoExpert ? '已开启：自动激活专家模式' : '已关闭：自动激活', 'success');
    });

    const promptListEl = panel.querySelector('#prompt-list');
    const promptEditArea = panel.querySelector('#prompt-edit-area');
    const promptEditId = panel.querySelector('#prompt-edit-id');
    const promptEditTitle = panel.querySelector('#prompt-edit-title');
    const promptEditContent = panel.querySelector('#prompt-edit-content');
    const promptEditTime = panel.querySelector('#prompt-edit-time');

    window.dsSelectPrompt = function (id) {
        State.activeId = id;
        State.save();
        renderUI();
        globalMenu.classList.remove('open');
        toast('指令已生效', 'success');
    };

    function renderUI() {
        const list = State.prompts;
        const activeId = State.activeId;
        const fragPanel = document.createDocumentFragment();

        if (!list.length) {
            promptListEl.innerHTML = '<div style="color:var(--dsw-alias-label-tertiary);font-size:14px;padding:48px 16px;text-align:center;background:var(--dsw-alias-bg-layer-1);border-radius:16px;border:2px dashed var(--dsw-alias-border-l2);">✨ 还没有属于你的独家指令哦，点击右上角新建吧</div>';
        } else {
            promptListEl.innerHTML = '';
            list.forEach(p => {
                const row = document.createElement('div');
                row.className = 'dsp-prompt-item';

                const timeBadge = p.includeTime ? `<span class="dsp-badge-time"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2 2"></path><path d="M5 3L2 6"></path><path d="M19 3l3 3"></path></svg>动态时间</span>` : '';

                row.innerHTML = `
          <div class="dsp-prompt-header">
            <div style="display:flex;align-items:center;">
              <span class="dsp-prompt-title">${esc(p.title)}</span>
              ${timeBadge}
            </div>
            <div class="dsp-prompt-actions">
              <button class="edit">编辑</button>
              <button class="del">删除</button>
            </div>
          </div>
          <div class="dsp-prompt-preview">${esc(p.content)}</div>
        `;
                row.querySelector('.edit').onclick = () => openPromptEditor(p);
                row.querySelector('.del').onclick = () => deletePrompt(p.id);
                fragPanel.appendChild(row);
            });
            promptListEl.appendChild(fragPanel);
        }

        const fragMenu = document.createDocumentFragment();
        let activeTitle = "无 (纯净对话)";

        const nullItem = document.createElement('div');
        nullItem.className = 'dsp-custom-menu-item' + (!activeId ? ' active' : '');
        nullItem.innerHTML = '无 (纯净对话)';
        nullItem.onclick = () => window.dsSelectPrompt('');
        fragMenu.appendChild(nullItem);

        list.forEach(p => {
            const item = document.createElement('div');
            item.className = 'dsp-custom-menu-item' + (p.id === activeId ? ' active' : '');
            item.textContent = p.title;
            item.onclick = () => window.dsSelectPrompt(p.id);
            fragMenu.appendChild(item);
            if (p.id === activeId) activeTitle = p.title;
        });

        globalMenu.innerHTML = '';
        globalMenu.appendChild(fragMenu);

        const nativeQsText = document.getElementById('dsp-qs-text');
        const nativePill = document.getElementById('dsp-pill-container');

        if (nativeQsText) nativeQsText.textContent = activeTitle;
        if (nativePill) {
            if (activeId) nativePill.classList.add('active');
            else nativePill.classList.remove('active');
        }
    }

    panel.querySelector('#prompt-new-btn').onclick = () => openPromptEditor(null);
    panel.querySelector('#prompt-edit-cancel').onclick = () => { promptEditArea.style.display = 'none'; };

    panel.querySelector('#prompt-edit-save').onclick = () => {
        const title = promptEditTitle.value.trim();
        const content = promptEditContent.value.trim();
        const includeTime = promptEditTime.checked;

        if (!title || !content) { toast('标题和内容均不能为空哦', 'error'); return; }

        const id = promptEditId.value;
        if (id) {
            const p = State.prompts.find(x => x.id === id);
            if (p) { p.title = title; p.content = content; p.includeTime = includeTime; }
        } else {
            const newId = 'pr_' + Date.now();
            State.prompts.push({ id: newId, title, content, includeTime });
            if (!State.activeId) State.activeId = newId;
        }

        State.save();
        promptEditArea.style.display = 'none';
        renderUI();
        toast('保存成功，指令已就绪', 'success');
    };

    function openPromptEditor(p) {
        promptEditArea.style.display = 'block';
        if (p) {
            promptEditId.value = p.id;
            promptEditTitle.value = p.title;
            promptEditContent.value = p.content;
            promptEditTime.checked = !!p.includeTime;
        } else {
            promptEditId.value = '';
            promptEditTitle.value = '';
            promptEditContent.value = '';
            promptEditTime.checked = false;
        }
        setTimeout(() => { promptEditArea.scrollIntoView({ behavior: 'smooth', block: 'end' }); promptEditTitle.focus(); }, 50);
    }

    function deletePrompt(id) {
        if (!confirm('确定要删除这条精心编写的指令吗？')) return;
        State.prompts = State.prompts.filter(x => x.id !== id);
        State.save();
        if (State.activeId === id) State.activeId = '';
        renderUI();
        toast('指令已清理', 'info');
    }

    function injectNativeControls(container, targetNode) {
        const existing = document.getElementById('dsp-native-wrapper');
        if (existing) existing.remove();

        const wrapper = document.createElement('div');
        wrapper.id = 'dsp-native-wrapper';

        wrapper.innerHTML = `
      <div class="dsp-native-pill" id="dsp-pill-container">
        <div class="dsp-visual-box" id="dsp-custom-dropdown-trigger">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
             <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
             <circle cx="12" cy="12" r="3"></circle>
          </svg>
          <span id="dsp-qs-text">无 (纯净对话)</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px; opacity:0.7; flex-shrink:0;">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="dsp-pill-divider"></div>
        <button id="dsp-open-panel-btn" title="偏好设置">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <line x1="4" y1="21" x2="4" y2="14"></line>
            <line x1="4" y1="10" x2="4" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12" y2="3"></line>
            <line x1="20" y1="21" x2="20" y2="16"></line>
            <line x1="20" y1="12" x2="20" y2="3"></line>
            <line x1="1" y1="14" x2="7" y2="14"></line>
            <line x1="9" y1="8" x2="15" y2="8"></line>
            <line x1="17" y1="16" x2="23" y2="16"></line>
          </svg>
        </button>
      </div>
    `;

        if (targetNode && targetNode.nextSibling) {
            container.insertBefore(wrapper, targetNode.nextSibling);
        } else {
            container.appendChild(wrapper);
        }

        const trigger = wrapper.querySelector('#dsp-custom-dropdown-trigger');
        trigger.onclick = (e) => {
            e.stopPropagation();
            if (globalMenu.classList.contains('open')) {
                globalMenu.classList.remove('open');
                return;
            }
            const rect = trigger.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            globalMenu.style.left = rect.left + 'px';
            if (spaceBelow < 250) {
                globalMenu.style.top = 'auto';
                globalMenu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
                globalMenu.style.transformOrigin = 'bottom left';
                globalMenu.style.animation = 'dsp-dropup-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
            } else {
                globalMenu.style.top = (rect.bottom + 8) + 'px';
                globalMenu.style.bottom = 'auto';
                globalMenu.style.transformOrigin = 'top left';
                globalMenu.style.animation = 'dsp-dropdown-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
            }
            globalMenu.classList.add('open');
        };

        wrapper.querySelector('#dsp-open-panel-btn').onclick = () => togglePanel(true);
        renderUI();
    }

    // ==========================================
    //  模块 4：专家模式智能控制 (完美接管)
    // ==========================================
    let manualOverride = false;
    let lastUrl = location.href;

    function checkAndSwitchExpertMode() {
        if (!State.autoExpert) return;

        if (lastUrl !== location.href) {
            lastUrl = location.href;
            manualOverride = false;
        }

        if (manualOverride) return;

        const expert = document.querySelector('div[data-model-type="expert"][role="radio"]');
        const quick = document.querySelector('div[data-model-type="default"][role="radio"]');

        if (expert && quick && quick.getAttribute('aria-checked') === 'true') {
            expert.click();
        }
    }

    setInterval(checkAndSwitchExpertMode, 500);

    document.addEventListener('click', (e) => {
        if (globalMenu.classList.contains('open')) {
            const trigger = document.getElementById('dsp-custom-dropdown-trigger');
            if ((!trigger || !trigger.contains(e.target)) && !globalMenu.contains(e.target)) {
                globalMenu.classList.remove('open');
            }
        }

        if (!State.autoExpert) return;

        const isModelSwitch = e.target.closest('div[data-model-type]');
        if (isModelSwitch) {
            manualOverride = true;
        }

        const btn = e.target.closest('div[role="button"]');
        if (btn && (btn.innerText.includes('新对话') || btn.innerText.includes('New'))) {
            manualOverride = false;
        }
    }, { passive: true, capture: true });

    window.addEventListener('scroll', () => {
        if (globalMenu.classList.contains('open')) globalMenu.classList.remove('open');
    }, { capture: true, passive: true });

    window.addEventListener('resize', () => {
        if (globalMenu.classList.contains('open')) globalMenu.classList.remove('open');
    }, { passive: true });

    function startNativeObserver() {
        let isObserving = false;
        const observer = new MutationObserver(() => {
            if (isObserving) return;
            isObserving = true;
            requestAnimationFrame(() => {
                isObserving = false;

                if (!document.getElementById('dsp-native-wrapper')) {
                    let targetBtn = null;
                    const keywords = ['联网搜索', '深度思考', '智能搜索', 'DeepThink', 'Search', 'Web Search'];

                    const candidates = document.querySelectorAll('div[role="switch"], div[role="button"], div[role="checkbox"], button, div[tabindex]');
                    for (let btn of candidates) {
                        const txt = btn.textContent.trim();
                        if (keywords.some(k => txt.includes(k))) {
                            targetBtn = btn;
                        }
                    }

                    if (!targetBtn) {
                        const spans = document.querySelectorAll('span, div');
                        for (let s of spans) {
                            if (s.children.length > 2) continue;
                            const txt = s.textContent.trim();
                            if (keywords.some(k => txt === k || txt === k + ' (R1)')) {
                                targetBtn = s;
                            }
                        }
                    }

                    if (targetBtn && targetBtn.parentNode) {
                        let container = targetBtn.parentNode;
                        // 如果父节点不是 flex 容器，尝试向上寻找一级，以保证 UI 对齐
                        if (container && window.getComputedStyle(container).display !== 'flex' && container.parentNode) {
                            if (window.getComputedStyle(container.parentNode).display === 'flex') {
                                targetBtn = container;
                                container = container.parentNode;
                            }
                        }
                        injectNativeControls(container, targetBtn);
                    }
                }
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('DOMContentLoaded', () => {
        renderUI();
        startNativeObserver();
        console.log('[DS Prompt Manager] V4.3 Loaded (Evolved Prompt Injection Supported)');
>>>>>>> 79286db (fix: evolve prompt injection logic and update UI entry selector for latest DeepSeek API (v1.1.1))
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

    window.addEventListener('DOMContentLoaded', () => {
    renderUI();
    startNativeObserver();
    console.log('[DS Prompt Manager] V4.3 Loaded (Dark Mode Fully Supported & Expert Switch Optimized)');
});
}) ();
