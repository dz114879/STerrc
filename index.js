import { eventSource, event_types, saveSettingsDebounced, is_send_press } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';

const extensionName = 'vertin-tips';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// 默认设置
const defaultSettings = {
    enabled: true,
    volume: 0.5,
    successSound: 'voice.mp3',  // 成功提示音文件名
    errorSound: 'error_normal.mp3'  // 错误提示音文件名
};

// 音频对象
let successSound = null;  // 成功提示音
let errorSound = null;    // 错误提示音

// 可用音频文件列表
let successAudioFiles = [];
let errorAudioFiles = [];

// 自定义音频（仅 IndexedDB，本地上传）
const IDB_DB_NAME = 'vertin-tips';
const IDB_STORE = 'audios';

/**
 * customAudios: 内存清单，页面加载时从 IDB 载入
 * 项结构：
 * { id, kind: 'success'|'error', type: 'idb', name, mime?, size?, createdAt, data?(Blob) }
 */
let customAudios = { success: [], error: [] };
let idbDb = null;

// 对象URL引用，便于在更换音源时释放
let successObjectURL = null;
let errorObjectURL = null;

// 跟踪生成状态
let generationState = {
    isGenerating: false,
    wasStoppedOrError: false,
    lastErrorTime: 0
};

// 初始化扩展
jQuery(async () => {
   // 加载设置
   if (!extension_settings[extensionName]) {
       extension_settings[extensionName] = defaultSettings;
   }

   // 初始化并读取自定义音频清单（IndexedDB）
   try {
       await initIDB();
       await loadCustomAudios();
   } catch (e) {
       console.warn(`[${extensionName}] IndexedDB 初始化或读取失败:`, e);
   }

   // 扫描内置音频文件（可选）
   await scanAudioFiles();

   // 初始化音频
   initAudio();

   // 注册事件监听器
   registerEventListeners();

   // 添加设置界面
   addSettingsUI();

   console.log(`[${extensionName}] 扩展已加载`);
});

// 扫描音频文件夹中的所有音频文件
async function scanAudioFiles() {
    // 获取文件列表
    async function getFilesFromFolder(folderType) {
        const testFiles = new Set();

        // 根据文件夹类型添加常见文件
        if (folderType === 'success') {
            ['voice.mp3', 'okay.mp3', '叮咚鸡！.mp3', 'success.mp3',
             'complete.mp3', 'done.mp3', 'notify.mp3', '星际曼波.mp3', '哈基米.mp3', '花Q.mp3'].forEach(f => testFiles.add(f));
        } else {
            ['error_normal.mp3', 'error.mp3', 'fail.mp3', 'warning.mp3',
             '1754735971690474921-299758139797688.mp3', '星际曼波.mp3', '哈基米.mp3', 'faq.mp3'].forEach(f => testFiles.add(f));
        }

        // 添加用户可能添加的文件名（减少测试数量）
        // 单个字母 A-Z（只测试大写）
        for (let i = 65; i <= 90; i++) {
            testFiles.add(`${String.fromCharCode(i)}.mp3`);
        }

        // 数字 1-10
        for (let i = 1; i <= 10; i++) {
            testFiles.add(`${i}.mp3`);
        }

        // 测试文件是否存在（静默处理404）
        const existingFiles = [];
        for (const filename of testFiles) {
            const testUrl = `/${extensionFolderPath}/audio/${folderType}/${filename}`;

            // 使用AbortController来设置超时
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 500);

            try {
                const response = await fetch(testUrl, {
                    method: 'HEAD',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                    existingFiles.push(filename);
                    console.log(`[${extensionName}] 找到文件: ${folderType}/${filename}`);
                }
            } catch (e) {
                clearTimeout(timeoutId);
                // 静默处理错误，不输出到控制台
            }
        }

        return existingFiles;
    }

    // 扫描成功音频文件
    const newSuccessFiles = await getFilesFromFolder('success');
    const successChanged = JSON.stringify(successAudioFiles) !== JSON.stringify(newSuccessFiles);
    successAudioFiles = newSuccessFiles;

    // 扫描错误音频文件
    const newErrorFiles = await getFilesFromFolder('error');
    const errorChanged = JSON.stringify(errorAudioFiles) !== JSON.stringify(newErrorFiles);
    errorAudioFiles = newErrorFiles;

    // 显示扫描结果
    if (successAudioFiles.length === 0) {
        console.warn(`[${extensionName}] 未找到成功音频文件，请在 audio/success/ 文件夹中放置音频文件`);
    } else {
        console.log(`[${extensionName}] 找到成功音频: ${successAudioFiles.join(', ')}`);
    }

    if (errorAudioFiles.length === 0) {
        console.warn(`[${extensionName}] 未找到错误音频文件，请在 audio/error/ 文件夹中放置音频文件`);
    } else {
        console.log(`[${extensionName}] 找到错误音频: ${errorAudioFiles.join(', ')}`);
    }

    return { successChanged, errorChanged };
}

// ===== 自定义音频（仅 IndexedDB，本地上传）功能 =====

// 打开或初始化 IndexedDB
async function initIDB() {
    if (idbDb) return idbDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_DB_NAME, 1);
        request.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = (ev) => {
            idbDb = ev.target.result;
            resolve(idbDb);
        };
        request.onerror = () => reject(request.error);
    });
}

// 生成UUID
function vt_uuid() {
    try {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    } catch {}
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// 从 IDB 读取清单（仅载入 type === 'idb'）
async function loadCustomAudios() {
    await initIDB();
    return new Promise((resolve, reject) => {
        const tx = idbDb.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.getAll();
        req.onsuccess = () => {
            const items = (req.result || []).filter(x => x?.type === 'idb');
            customAudios.success = items.filter(x => x.kind === 'success');
            customAudios.error = items.filter(x => x.kind === 'error');
            resolve(items);
        };
        req.onerror = () => reject(req.error);
    });
}

// 新增本地文件
async function addCustomFile(kind, file) {
    await initIDB();
    const id = vt_uuid();
    const rec = {
        id,
        kind, // 'success' | 'error'
        type: 'idb',
        name: file.name || 'audio',
        mime: file.type || 'audio/mpeg',
        size: file.size || 0,
        createdAt: Date.now(),
        data: file, // 直接保存 Blob/File
    };
    return new Promise((resolve, reject) => {
        const tx = idbDb.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.put(rec);
        req.onsuccess = async () => {
            await loadCustomAudios();
            resolve(rec);
        };
        req.onerror = () => reject(req.error);
    });
}

// 删除自定义项
async function deleteCustomItem(id) {
    await initIDB();
    return new Promise((resolve, reject) => {
        const tx = idbDb.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.delete(id);
        req.onsuccess = async () => {
            await loadCustomAudios();
            resolve();
        };
        req.onerror = () => reject(req.error);
    });
}

// 查询自定义项
function getCustomById(kind, id) {
    return (customAudios[kind] || []).find(x => x.id === id);
}

// 构建 Audio 实例（支持 内置/IDB）
function buildAudioFor(kind, value) {
    try {
        if (!value) return null;

        // 释放旧的对象URL
        try {
            if (kind === 'success' && successObjectURL) {
                URL.revokeObjectURL(successObjectURL);
                successObjectURL = null;
            }
            if (kind === 'error' && errorObjectURL) {
                URL.revokeObjectURL(errorObjectURL);
                errorObjectURL = null;
            }
        } catch {}

        let src = '';

        if (typeof value === 'string' && value.startsWith('idb:')) {
            const id = value.slice(4);
            const rec = getCustomById(kind, id);
            if (rec && rec.data) {
                const objUrl = URL.createObjectURL(rec.data);
                src = objUrl;
                if (kind === 'success') successObjectURL = objUrl;
                else errorObjectURL = objUrl;
            }
        } else {
            // 内置文件
            src = `/${extensionFolderPath}/audio/${kind}/${value}`;
        }

        if (!src) return null;

        const audio = new Audio(src);
        audio.volume = extension_settings[extensionName].volume;
        audio.load();
        return audio;
    } catch (error) {
        console.error(`[${extensionName}] 构建音频失败:`, error);
        return null;
    }
}

// 初始化音频
function initAudio() {
    const settings = extension_settings[extensionName];

    try {
        // 成功提示音（支持 内置/IDB）
        if (settings.successSound) {
            const a = buildAudioFor('success', settings.successSound);
            successSound = a;
        } else {
            successSound = null;
        }

        // 错误提示音（支持 内置/IDB）
        if (settings.errorSound) {
            const a2 = buildAudioFor('error', settings.errorSound);
            errorSound = a2;
        } else {
            errorSound = null;
        }
    } catch (error) {
        console.error(`[${extensionName}] 无法加载音频文件:`, error);
    }
}

// 注册事件监听器
function registerEventListeners() {
    // 监听生成开始事件
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    // 监听生成停止事件（错误或手动停止）
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    // 监听生成结束事件（正常完成）
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    // 监听toastr错误消息来检测API错误
    interceptToastrErrors();

    // 拦截fetch响应来检测HTTP错误
    interceptFetchErrors();
}

// 生成开始时
function onGenerationStarted() {
    generationState.isGenerating = true;
    generationState.wasStoppedOrError = false;
    console.log(`[${extensionName}] AI开始生成回复`);
}

// 拦截fetch响应来检测HTTP错误
function interceptFetchErrors() {
    const originalFetch = window.fetch;

    window.fetch = async function(...args) {
        try {
            const response = await originalFetch.apply(this, args);
            const url = args[0]?.toString() || '';

            // 检查是否是API请求且返回错误状态
            if (url.includes('/api/') && !response.ok && response.status >= 400) {
                const errorInfo = `HTTP ${response.status} ${response.statusText}`;
                console.log(`[${extensionName}] 检测到HTTP错误: ${errorInfo} - ${url}`);

                // 如果正在生成AI回复，记录错误
                if (generationState.isGenerating) {
                    generationState.wasStoppedOrError = true;
                    generationState.lastErrorTime = Date.now();

                    // 延迟播放错误音，让toastr先显示
                    if (extension_settings[extensionName].enabled) {
                        setTimeout(() => {
                            playErrorSound();
                        }, 200);
                    }
                }
            }

            return response;
        } catch (error) {
            // 网络错误（无法连接、超时等）
            const url = args[0]?.toString() || '';
            if (url.includes('/api/') && generationState.isGenerating) {
                console.log(`[${extensionName}] 检测到网络错误: ${error.message}`);
                generationState.wasStoppedOrError = true;
                generationState.lastErrorTime = Date.now();

                if (extension_settings[extensionName].enabled) {
                    setTimeout(() => {
                        playErrorSound();
                    }, 200);
                }
            }
            throw error;
        }
    };
}

// 拦截toastr错误消息
function interceptToastrErrors() {
    // 保存原始的toastr.error函数
    const originalToastrError = window.toastr.error;

    // 定义HTTP错误码列表
    const httpErrorPatterns = [
        // 4xx 客户端错误
        /\b400\b/, /\b401\b/, /\b402\b/, /\b403\b/, /\b404\b/,
        /\b405\b/, /\b406\b/, /\b407\b/, /\b408\b/, /\b409\b/,
        /\b410\b/, /\b411\b/, /\b412\b/, /\b413\b/, /\b414\b/,
        /\b415\b/, /\b416\b/, /\b417\b/, /\b418\b/, /\b421\b/,
        /\b422\b/, /\b423\b/, /\b424\b/, /\b425\b/, /\b426\b/,
        /\b428\b/, /\b429\b/, /\b431\b/, /\b451\b/,
        // 5xx 服务器错误
        /\b500\b/, /\b501\b/, /\b502\b/, /\b503\b/, /\b504\b/,
        /\b505\b/, /\b506\b/, /\b507\b/, /\b508\b/, /\b510\b/, /\b511\b/,
        // 常见错误关键词
        /unauthorized/i, /forbidden/i, /not found/i, /bad request/i,
        /internal server error/i, /service unavailable/i, /gateway timeout/i,
        /too many requests/i, /rate limit/i, /quota exceeded/i,
        /network error/i, /connection refused/i, /timeout/i,
        /failed to fetch/i, /fetch error/i, /request failed/i,
        /ECONNREFUSED/, /ETIMEDOUT/, /ENOTFOUND/, /ECONNRESET/
    ];

    // 重写toastr.error函数
    window.toastr.error = function(message, title, options) {
        const fullText = `${title || ''} ${message || ''}`;
        let isApiError = false;
        let errorType = 'unknown';

        // 检查是否包含API关键词
        if (title && (title.includes('API') || title.includes('Error') || title.includes('Failed'))) {
            isApiError = true;
            errorType = 'api_keyword';
        }

        // 检查是否包含HTTP错误码或错误关键词
        for (const pattern of httpErrorPatterns) {
            if (pattern.test(fullText)) {
                isApiError = true;
                errorType = pattern.source;
                break;
            }
        }

        // 检测到错误时的处理
        if (isApiError) {
            console.log(`[${extensionName}] 检测到错误 [${errorType}]: ${fullText}`);
            generationState.wasStoppedOrError = true;
            generationState.lastErrorTime = Date.now();

            // 如果正在生成，播放错误音
            if (generationState.isGenerating && extension_settings[extensionName].enabled) {
                setTimeout(() => {
                    playErrorSound();
                }, 100); // 小延迟确保其他处理完成
            }
        }

        // 调用原始函数
        return originalToastrError.call(this, message, title, options);
    };
}

// 生成停止时（错误或手动停止）
function onGenerationStopped() {
    const settings = extension_settings[extensionName];

    generationState.wasStoppedOrError = true;
    generationState.isGenerating = false;
    console.log(`[${extensionName}] AI生成被手动停止`);

    // 只在手动停止时播放错误音（API错误由toastr拦截处理）
    // 检查是否刚刚有API错误（1秒内）
    const timeSinceError = Date.now() - generationState.lastErrorTime;
    if (settings.enabled && timeSinceError > 1000) {
        playErrorSound();
    }
}

// 生成正常结束时
function onGenerationEnded() {
    const settings = extension_settings[extensionName];

    // 检查是否有错误发生（包括API错误）
    const hasError = generationState.wasStoppedOrError ||
                    (Date.now() - generationState.lastErrorTime < 2000);

    // 只有在启用且没有错误的情况下才播放成功音
    if (settings.enabled && !hasError && generationState.isGenerating) {
        console.log(`[${extensionName}] AI回复成功，播放成功音`);
        playSuccessSound();
    } else if (settings.enabled && hasError) {
        console.log(`[${extensionName}] 生成结束但有错误，不播放成功音`);
    }

    // 重置状态
    generationState.isGenerating = false;
    generationState.wasStoppedOrError = false;
}

// 播放成功提示音
function playSuccessSound() {
    if (!successSound) {
        console.warn(`[${extensionName}] 成功音频未初始化，尝试重新初始化`);
        initAudio();
        if (!successSound) return;
    }

    try {
        // 重置音频以支持快速连续播放
        successSound.currentTime = 0;
        successSound.volume = extension_settings[extensionName].volume;

        // 播放音频
        successSound.play().catch(error => {
            console.error(`[${extensionName}] 播放成功提示音失败:`, error);
            // 尝试重新创建音频对象
            initAudio();
        });
    } catch (error) {
        console.error(`[${extensionName}] 播放成功提示音失败:`, error);
    }
}

// 播放错误提示音
function playErrorSound() {
    if (!errorSound) {
        console.warn(`[${extensionName}] 错误音频未初始化，尝试重新初始化`);
        initAudio();
        if (!errorSound) return;
    }

    try {
        // 重置音频以支持快速连续播放
        errorSound.currentTime = 0;
        errorSound.volume = extension_settings[extensionName].volume;

        // 播放音频
        errorSound.play().catch(error => {
            console.error(`[${extensionName}] 播放错误提示音失败:`, error);
            // 尝试重新创建音频对象
            initAudio();
        });
    } catch (error) {
        console.error(`[${extensionName}] 播放错误提示音失败:`, error);
    }
}

// 更新下拉框选项
function updateSelectOptions() {
    const successSelect = $('#vertin-tips-success-select');
    const errorSelect = $('#vertin-tips-error-select');

    // 清空现有选项
    successSelect.empty();
    errorSelect.empty();

    // 添加默认选项
    successSelect.append('<option value="">无</option>');
    errorSelect.append('<option value="">无</option>');

    // 工具函数
    const addOption = (select, value, label) => {
        select.append(`<option value="${value}">${label}</option>`);
    };

    // 添加内置成功音频文件
    if (successAudioFiles.length > 0) {
        successAudioFiles.forEach(file => {
            const displayName = file.replace(/\.[^/.]+$/, "");
            addOption(successSelect, file, displayName);
        });
    } else {
        successSelect.append('<option value="" disabled>请上传，或在 audio/success/ 放置音频文件</option>');
    }

    // 添加内置错误音频文件
    if (errorAudioFiles.length > 0) {
        errorAudioFiles.forEach(file => {
            const displayName = file.replace(/\.[^/.]+$/, "");
            addOption(errorSelect, file, displayName);
        });
    } else {
        errorSelect.append('<option value="" disabled>请上传，或在 audio/error/ 放置音频文件</option>');
    }

    // 添加自定义（IDB）成功项
    (customAudios.success || []).forEach(rec => {
        const value = `idb:${rec.id}`;
        const label = `[自定义] ${rec.name || ('音频 ' + rec.id.slice(0,6))}`;
        addOption(successSelect, value, label);
    });

    // 添加自定义（IDB）错误项
    (customAudios.error || []).forEach(rec => {
        const value = `idb:${rec.id}`;
        const label = `[自定义] ${rec.name || ('音频 ' + rec.id.slice(0,6))}`;
        addOption(errorSelect, value, label);
    });

    // 设置当前值
    const settings = extension_settings[extensionName];

    // 成功选择回显（仅支持 idb 与内置）
    (function() {
        const val = settings.successSound;
        if (!val) {
            successSelect.val('');
            return;
        }
        if (typeof val === 'string' && val.startsWith('idb:')) {
            const id = val.slice(4);
            const exists = !!getCustomById('success', id);
            if (exists) {
                successSelect.val(val);
                return;
            }
        } else if (typeof val === 'string' && successAudioFiles.includes(val)) {
            successSelect.val(val);
            return;
        }
        successSelect.val('');
        settings.successSound = '';
    })();

    // 错误选择回显（仅支持 idb 与内置）
    (function() {
        const val = settings.errorSound;
        if (!val) {
            errorSelect.val('');
            return;
        }
        if (typeof val === 'string' && val.startsWith('idb:')) {
            const id = val.slice(4);
            const exists = !!getCustomById('error', id);
            if (exists) {
                errorSelect.val(val);
                return;
            }
        } else if (typeof val === 'string' && errorAudioFiles.includes(val)) {
            errorSelect.val(val);
            return;
        }
        errorSelect.val('');
        settings.errorSound = '';
    })();
}

// 添加设置界面
function addSettingsUI() {
    const settingsHtml = `
    <div id="vertin-tips-settings">
        <div class="inline-drawer">
            <div id="vertin-tips-header" class="inline-drawer-toggle inline-drawer-header">
                <b>Vertin的小提示</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div id="vertin-tips-content" class="inline-drawer-content" style="display: none;">
                <div style="padding: 10px;">
                    <div style="margin-bottom: 10px;">
                        <label class="checkbox_label">
                            <input id="vertin-tips-enabled" type="checkbox" />
                            <span>启用提示音</span>
                        </label>
                    </div>

                    <!-- 提示信息 -->
                    <div style="margin-bottom: 10px; font-size: 12px; color: #888; line-height: 1.4;">
                        您可以上传本地音频；内置扫描可能受环境限制。支持 mp3/wav/ogg。
                    </div>

                    <!-- 成功提示音选择 -->
                    <div style="margin-bottom: 10px;">
                        <label>成功提示音:</label>
                        <div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap;">
                            <select id="vertin-tips-success-select" class="text_pole" style="flex: 1; min-width: 220px;">
                                <option value="">无</option>
                            </select>
                            <button id="vertin-tips-test-success" class="menu_button" title="测试">
                                <i class="fa-solid fa-play"></i>
                            </button>
                            <button id="vertin-tips-upload-success" class="menu_button" title="上传本地文件">
                                <i class="fa-solid fa-upload"></i>
                            </button>
                            <input id="vertin-tips-file-success" type="file" accept="audio/*,.mp3,.wav,.ogg" style="display:none" />
                        </div>
                    </div>

                    <!-- 错误提示音选择 -->
                    <div style="margin-bottom: 10px;">
                        <label>错误提示音:</label>
                        <div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap;">
                            <select id="vertin-tips-error-select" class="text_pole" style="flex: 1; min-width: 220px;">
                                <option value="">无</option>
                            </select>
                            <button id="vertin-tips-test-error" class="menu_button" title="测试">
                                <i class="fa-solid fa-play"></i>
                            </button>
                            <button id="vertin-tips-upload-error" class="menu_button" title="上传本地文件">
                                <i class="fa-solid fa-upload"></i>
                            </button>
                            <input id="vertin-tips-file-error" type="file" accept="audio/*,.mp3,.wav,.ogg" style="display:none" />
                        </div>
                    </div>

                    <!-- 音量控制 -->
                    <div style="margin-bottom: 10px;">
                        <label>
                            <div>音量: <span id="vertin-tips-volume-value">50</span>%</div>
                            <input id="vertin-tips-volume" type="range" min="0" max="100" value="50" style="width: 100%;" />
                        </label>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    // 添加到扩展设置面板
    $('#extensions_settings').append(settingsHtml);

    // 绑定设置控件
    bindSettingsControls();

    // 更新下拉框选项
    updateSelectOptions();
}

// 绑定设置控件
function bindSettingsControls() {
    const settings = extension_settings[extensionName];

    // 启用/禁用开关
    $('#vertin-tips-enabled')
        .prop('checked', settings.enabled)
        .on('change', function() {
            settings.enabled = $(this).prop('checked');
            saveSettingsDebounced();
        });

    // 成功音选择
    $('#vertin-tips-success-select').on('change', function() {
        settings.successSound = $(this).val();
        saveSettingsDebounced();
        initAudio();
    });

    // 错误音选择
    $('#vertin-tips-error-select').on('change', function() {
        settings.errorSound = $(this).val();
        saveSettingsDebounced();
        initAudio();
    });

    // 音量滑块
    $('#vertin-tips-volume')
        .val(settings.volume * 100)
        .on('input', function() {
            const volume = $(this).val() / 100;
            settings.volume = volume;
            $('#vertin-tips-volume-value').text($(this).val());

            if (successSound) successSound.volume = volume;
            if (errorSound) errorSound.volume = volume;

            saveSettingsDebounced();
        });

    // 更新音量显示
    $('#vertin-tips-volume-value').text(Math.round(settings.volume * 100));

    // 测试按钮
    $('#vertin-tips-test-success').on('click', function() {
        playSuccessSound();
    });
    $('#vertin-tips-test-error').on('click', function() {
        playErrorSound();
    });

    // ========== 上传（仅本地文件） ==========
    function validateFile(file) {
        if (!file) return '未选择文件';
        const okType = file.type?.startsWith('audio/') || /\.(mp3|wav|ogg)$/i.test(file.name || '');
        if (!okType) return '仅支持音频文件（mp3/wav/ogg）';
        const max = 10 * 1024 * 1024; // 10MB
        if (file.size > max) return '文件过大（>10MB）';
        return '';
    }

    async function afterAdd(kind, rec) {
        try {
            // 选中刚添加的项（仅本地IDB）
            const value = `idb:${rec.id}`;
            if (kind === 'success') {
                settings.successSound = value;
            } else {
                settings.errorSound = value;
            }
            saveSettingsDebounced();
            updateSelectOptions();
            initAudio();
            if (window.toastr) toastr.success('已添加并选中音频');
        } catch (e) {
            console.error(`[${extensionName}] 添加后处理失败:`, e);
        }
    }

    // 上传成功音
    $('#vertin-tips-upload-success').on('click', function() {
        $('#vertin-tips-file-success').val('').trigger('click');
    });
    $('#vertin-tips-file-success').on('change', async function() {
        const file = this.files && this.files[0];
        const msg = validateFile(file);
        if (msg) { if (window.toastr) toastr.error(msg); return; }
        try {
            const rec = await addCustomFile('success', file);
            await afterAdd('success', rec);
        } catch (e) {
            console.error(e);
            if (window.toastr) toastr.error('添加失败');
        }
    });

    // 上传错误音
    $('#vertin-tips-upload-error').on('click', function() {
        $('#vertin-tips-file-error').val('').trigger('click');
    });
    $('#vertin-tips-file-error').on('change', async function() {
        const file = this.files && this.files[0];
        const msg = validateFile(file);
        if (msg) { if (window.toastr) toastr.error(msg); return; }
        try {
            const rec = await addCustomFile('error', file);
            await afterAdd('error', rec);
        } catch (e) {
            console.error(e);
            if (window.toastr) toastr.error('添加失败');
        }
    });



    // 折叠面板功能
    $('#vertin-tips-header').off('click').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        const content = $('#vertin-tips-content');
        const icon = $(this).find('.inline-drawer-icon');

        if (content.is(':visible')) {
            content.slideUp(200);
            icon.removeClass('up').addClass('down');
        } else {
            content.slideDown(200);
            icon.removeClass('down').addClass('up');
        }
    });
}
