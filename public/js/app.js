/**
 * 恋爱记事簿 - 前端主应用模块
 * 
 * 功能概述：
 * - 用户登录/登出认证
 * - 消息发送、编辑、删除
 * - 实时消息轮询与已读回执
 * - 表情选择器
 * - 图片上传与预览
 * - 相册浏览与管理（缩略图+原图）
 * - 爱心背景动画效果
 * 
 * @file 恋爱记事簿前端核心逻辑
 * @author Love Diary Team
 */
(function () {
  'use strict';

  // ==================== 全局状态变量 ====================

  /** API请求基础路径，空字符串表示同源请求 */
  const API_BASE = '';

  /** 当前用户的认证令牌，从localStorage持久化存储中恢复或登录时获取 */
  let authToken = localStorage.getItem('loveDiaryToken') || '';

  /** 当前登录用户信息对象，包含username和displayName等字段 */
  let currentUser = JSON.parse(localStorage.getItem('loveDiaryUser') || 'null');

  /** CSRF防护令牌，用于POST/PUT/DELETE请求的跨站请求伪造防护 */
  let csrfToken = '';

  /** 消息本地缓存数组，避免重复请求服务器数据 */
  let messagesCache = [];

  /** 上次检查已读状态的ISO时间字符串，用于增量查询已读变化 */
  let lastReadCheckTime = '';

  /** 当前未读消息总数，用于更新未读角标显示 */
  let unreadCount = 0;

  /** IntersectionObserver实例，用于检测未读消息进入可视区域并自动标记已读 */
  let readObserver = null;

  /** 当前正在编辑的消息ID，null表示未处于编辑状态 */
  let editingMessageId = null;

  /** 当前正在删除的消息ID，null表示未处于删除确认状态 */
  let deletingMessageId = null;

  /** 当前选中的发送者名称，默认为'小洋' */
  let selectedSender = '小洋';

  /** 待发送的图片文件对象，用户选择图片后暂存于此直到确认发送 */
  let pendingImageFile = null;

  /** 轮询是否正在进行的标志位 */
  let isPolling = false;

  /** 用于取消轮询请求的AbortController实例，支持轮询中断 */
  let pollAbortController = null;

  /** 当用户不在聊天区底部时，新到达的消息暂存于此数组 */
  let pendingNewMessages = [];

  /** 标志位：当前滚动位置是否在聊天区域底部（容差80px内） */
  let isAtBottom = true;

  /** 短期图片访问签名令牌，有效期5分钟 */
  let imageToken = '';

  /** 图片签名令牌过期时间戳 */
  let imageTokenExpiresAt = 0;

  // ==================== 工具函数 ====================

  /**
   * 为加密图片URL追加认证令牌参数
   * 
   * 由于后端对加密图片资源进行Token认证保护，
   * 前端在通过<img>标签加载图片时需要将token作为query参数传递。
   * 此函数统一处理URL拼接逻辑。
   * 
   * @param {string} url - 原始图片URL路径
   * @returns {string} 追加了token参数后的完整URL；若url或authToken为空则原样返回
   */
  async function fetchImageToken() {
    if (imageToken && Date.now() < imageTokenExpiresAt - 60000) return;
    try {
      const res = await fetch(`${API_BASE}/api/image-token`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        imageToken = data.imageToken;
        imageTokenExpiresAt = data.expiresAt;
      }
    } catch (e) {}
  }

  function authImageUrl(url) {
    if (!url) return url;
    const sep = url.includes('?') ? '&' : '?';
    if (imageToken) {
      return url + sep + 'token=' + encodeURIComponent(imageToken);
    }
    if (authToken) {
      return url + sep + 'token=' + encodeURIComponent(authToken);
    }
    return url;
  }

  /**
   * 表情符号常量集合
   * 包含80个常用表情，分为：爱心类、情感类、花卉装饰类、天气自然类、食物饮料类、动物类、手势类、电子娱乐类、成就奖励类
   * @type {string[]}
   */
  const EMOJIS = [
    '❤️', '💕', '💖', '💗', '💓', '💞', '💘', '💝',
    '😘', '🥰', '😍', '😻', '💑', '👩‍❤️‍👨', '💏', '🤗',
    '😊', '😄', '🥺', '😢', '😭', '😤', '🙈', '🙉',
    '🌹', '🌸', '🌺', '🌻', '🎀', '🎁', '🎈', '🎉',
    '☀️', '🌙', '⭐', '🌈', '☁️', '❄️', '🔥', '💫',
    '🍰', '🧁', '🍫', '☕', '🥂', '🍷', '🍕', '🍔',
    '🐱', '🐶', '🐰', '🐻', '🦊', '🐼', '🐨', '🦁',
    '👍', '👎', '👋', '✌️', '🤟', '💪', '🙏', '🤝',
    '📱', '💻', '📷', '🎵', '🎶', '🎤', '🎧', '🎬',
    '💯', '✨', '💎', '🏆', '🎯', '🎨', '📚', '✈️'
  ];

  /**
   * DOM元素快捷选择器，封装document.querySelector
   * @param {string} sel - CSS选择器字符串
   * @returns {Element|null} 匹配到的第一个DOM元素，无匹配返回null
   */
  const $ = (sel) => document.querySelector(sel);

  /**
   * DOM元素批量选择器，封装document.querySelectorAll
   * @param {string} sel - CSS选择器字符串
   * @returns {NodeList<Element>} 匹配到的所有DOM元素列表
   */
  const $$ = (sel) => document.querySelectorAll(sel);

  // ==================== 网络请求层 ====================

  /**
   * 从服务端获取CSRF令牌
   * 
   * CSRF（Cross-Site Request Forgery）令牌用于防止跨站请求伪造攻击。
   * 在每次会话初始化或CSRF验证失败后重新获取。
   * 获取成功后将令牌存入全局csrfToken变量供后续请求使用。
   * 
   * @async
   * @returns {Promise<void>} 无返回值，结果写入全局csrfToken变量
   */
  async function fetchCsrfToken() {
    try {
      const res = await fetch(`${API_BASE}/api/csrf-token`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        csrfToken = data.csrfToken;
      }
    } catch (e) { }
  }

  /**
   * 安全的HTTP请求封装函数
   * 
   * 在原生fetch基础上增加了以下功能：
   * 1. 自动附加Authorization Bearer Token头
   * 2. 对非GET请求自动附加x-csrf-token头
   * 3. 遇到403 CSRF错误时自动重试（重新获取token后重发）
   * 
   * @async
   * @param {string} url - 请求URL（相对路径或绝对路径）
   * @param {Object} [options={}] - fetch请求配置选项（method, headers, body等）
   * @returns {Promise<Response>} fetch Response对象
   */
  async function safeFetch(url, options = {}) {
    if (!options.headers) options.headers = {};
    if (authToken) options.headers['Authorization'] = `Bearer ${authToken}`;
    if (csrfToken && options.method && options.method !== 'GET') {
      options.headers['x-csrf-token'] = csrfToken;
    }
    const res = await fetch(url, options);
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.error && data.error.includes('CSRF')) {
        await fetchCsrfToken();
        if (csrfToken) {
          options.headers['x-csrf-token'] = csrfToken;
          return fetch(url, options);
        }
      }
    }
    return res;
  }

  /**
   * 带真实上传进度的HTTP请求（基于XMLHttpRequest）
   *
   * fetch API不支持upload.onprogress事件，无法获取真实的上传字节进度。
   * 此函数使用XMLHttpRequest实现，通过upload.onprogress回调实时报告上传进度。
   *
   * @param {string} url - 请求URL
   * @param {FormData} formData - 表单数据（文件等）
   * @param {Object} [options] - 配置选项
   * @param {Function} [options.onProgress] - 进度回调 function({loaded, total, percent, speed})
   * @returns {Promise<{ok: boolean, status: number, json: Object}>} 响应结果
   */
  function uploadWithProgress(url, formData, options = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);

      if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
      if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);

      let lastTime = Date.now();
      let lastLoaded = 0;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && options.onProgress) {
          const now = Date.now();
          const dt = now - lastTime;
          const dl = e.loaded - lastLoaded;
          const speed = dt > 0 ? Math.round(dl / dt * 1000) : 0;
          lastTime = now;
          lastLoaded = e.loaded;

          options.onProgress({
            loaded: e.loaded,
            total: e.total,
            percent: Math.round((e.loaded / e.total) * 100),
            speed: speed
          });
        }
      };

      xhr.onload = () => {
        if (xhr.status === 403) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.error && data.error.includes('CSRF')) {
              fetchCsrfToken().then(() => {
                if (csrfToken) {
                  const retryXhr = new XMLHttpRequest();
                  retryXhr.open('POST', url);
                  retryXhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
                  retryXhr.setRequestHeader('x-csrf-token', csrfToken);
                  retryXhr.onload = () => {
                    resolve({
                      ok: retryXhr.status >= 200 && retryXhr.status < 300,
                      status: retryXhr.status,
                      json: () => Promise.resolve(JSON.parse(retryXhr.responseText))
                    });
                  };
                  retryXhr.onerror = () => reject(new Error('网络请求失败'));
                  retryXhr.send(formData);
                } else {
                  resolve({ ok: false, status: xhr.status, json: () => Promise.resolve(data) });
                }
              }).catch(() => {
                resolve({ ok: false, status: xhr.status, json: () => Promise.resolve(data) });
              });
              return;
            }
          } catch (_) {}
        }

        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          json: () => Promise.resolve(JSON.parse(xhr.responseText))
        });
      };

      xhr.onerror = () => reject(new Error('网络请求失败'));
      xhr.send(formData);
    });
  }

  /** 格式化文件大小为人类可读字符串 */
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** 格式化传输速度为人类可读字符串 */
  function formatSpeed(bytesPerSec) {
    if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
    if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  }

  // ==================== 初始化入口 ====================

  /**
   * 应用主初始化函数
   * 
   * 作为应用启动的入口点，按顺序执行以下初始化：
   * 1. 初始化爱心Canvas动画背景
   * 2. 初始化表情选择器面板
   * 3. 绑定全局事件监听器
   * 4. 初始化滚动位置检测逻辑
   * 5. 初始化相册功能模块
   * 6. 根据认证状态决定展示登录页还是主应用界面
   * 
   * @returns {void}
   */
  function init() {
    initHeartCanvas();
    initEmojiPicker();
    bindEvents();
    initScrollDetection();
    initAlbum();

    if (authToken && currentUser) {
      showApp();
      loadMessages();
    } else {
      showLogin();
    }
  }

  // ==================== 爱心背景动画 ====================

  /**
   * 初始化爱心粒子Canvas动画系统
   * 
   * 使用HTML5 Canvas API绘制漂浮上升的爱心粒子，
   * 营造浪漫温馨的视觉氛围。
   * 动画特性包括：
   * - 25个爱心粒子同时存在
   * - 每个爱心有独立的大小、速度、透明度、旋转角度
   * - 使用贝塞尔曲线绘制心形路径
   * - 粒子飘出屏幕边界后自动重置到屏幕底部
   * - 支持窗口resize自适应
   * 
   * @returns {void}
   */
  function initHeartCanvas() {
    const canvas = $('#heartCanvas');
    const ctx = canvas.getContext('2d');
    let hearts = [];
    const MAX_HEARTS = 25;

    /**
     * Canvas尺寸调整处理函数
     * 监听window resize事件，确保Canvas始终铺满整个视口
     */
    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    resize();
    window.addEventListener('resize', resize);

    /**
     * 创建单个爱心粒子的属性配置对象
     * 
     * @returns {Object} 爱心粒子属性对象，包含以下字段：
     *   - x {number}: 水平初始位置（随机分布在屏幕宽度范围内）
     *   - y {number}: 垂直初始位置（屏幕底部下方20px处）
     *   - size {number}: 爱心大小（8~22px随机）
     *   - speed {number}: 上升速度（0.3~1.1px/frame）
     *   - opacity {number}: 透明度（0.08~0.33）
     *   - drift {number}: 水平漂移速度（-0.25~0.25px/frame）
     *   - rotation {number}: 初始旋转弧度（0~2π随机）
     *   - rotationSpeed {number}: 旋转速度（-0.005~0.005 rad/frame）
     *   - wobble {number}: 左右摆动相位（0~2π随机）
     *   - wobbleSpeed {number}: 摆动频率（0.01~0.03 rad/frame）
     */
    function createHeart() {
      return {
        x: Math.random() * canvas.width,
        y: canvas.height + 20,
        size: Math.random() * 14 + 8,
        speed: Math.random() * 0.8 + 0.3,
        opacity: Math.random() * 0.25 + 0.08,
        drift: (Math.random() - 0.5) * 0.5,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.01,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: Math.random() * 0.02 + 0.01
      };
    }

    // 初始化时将爱心分散分布在整个屏幕高度上，而非全部从底部开始
    for (let i = 0; i < MAX_HEARTS; i++) {
      const heart = createHeart();
      heart.y = Math.random() * canvas.height;
      hearts.push(heart);
    }

    /**
     * 绘制单个爱心图形到Canvas上下文
     * 
     * 使用两条三次贝塞尔曲线组合成心形轮廓，
     * 通过save/restore隔离变换状态避免影响其他绘制操作。
     * 
     * @param {CanvasRenderingContext2D} ctx - Canvas 2D渲染上下文
     * @param {number} x - 爱心中心点的X坐标
     * @param {number} y - 爱心中心点的Y坐标
     * @param {number} size - 爱心的尺寸（直径参考值）
     * @param {number} rotation - 旋转角度（弧度）
     * @param {number} opacity - 透明度（0~1）
     */
    function drawHeart(ctx, x, y, size, rotation, opacity) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.globalAlpha = opacity;
      ctx.fillStyle = `rgba(244, 114, 182, ${opacity})`;
      ctx.beginPath();
      const s = size / 2;
      ctx.moveTo(0, s * 0.4);
      ctx.bezierCurveTo(-s, -s * 0.3, -s * 0.6, -s, 0, -s * 0.4);
      ctx.bezierCurveTo(s * 0.6, -s, s, -s * 0.3, 0, s * 0.4);
      ctx.fill();
      ctx.restore();
    }

    /**
     * 动画帧循环函数
     * 
     * 每一帧执行的操作：
     * 1. 清除整个Canvas画布
     * 2. 更新每个爱心的物理属性（位置、旋转、摆动）
     * 3. 绘制当前帧的所有爱心
     * 4. 检测超出边界的爱心并重新生成
     * 5. 通过requestAnimationFrame调度下一帧
     */
    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      hearts.forEach((heart, i) => {
        heart.y -= heart.speed;
        heart.x += heart.drift + Math.sin(heart.wobble) * 0.3;
        heart.wobble += heart.wobbleSpeed;
        heart.rotation += heart.rotationSpeed;

        drawHeart(ctx, heart.x, heart.y, heart.size, heart.rotation, heart.opacity);

        if (heart.y < -30 || heart.x < -30 || heart.x > canvas.width + 30) {
          hearts[i] = createHeart();
        }
      });

      requestAnimationFrame(animate);
    }

    animate();
  }

  // ==================== 表情选择器 ====================

  /**
   * 初始化表情选择器面板
   * 
   * 遍历EMOJIS常量数组，为每个表情创建可点击的DOM元素。
   * 点击表情时的行为：
   * - 将表情插入到输入框的光标位置（而非末尾）
   * - 保持光标位于插入内容之后
   * - 自动调整输入框高度以适应新增内容
   * 
   * @returns {void}
   */
  function initEmojiPicker() {
    const grid = $('#emojiGrid');
    EMOJIS.forEach(emoji => {
      const item = document.createElement('span');
      item.className = 'emoji-item';
      item.textContent = emoji;
      item.addEventListener('click', () => {
        const input = $('#messageInput');
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;
        input.value = text.substring(0, start) + emoji + text.substring(end);
        input.selectionStart = input.selectionEnd = start + emoji.length;
        input.focus();
        autoResizeInput();
      });
      grid.appendChild(item);
    });
  }

  // ==================== 事件绑定 ====================

  /**
   * 绑定所有全局DOM事件监听器
   * 
   * 统一管理应用中所有的交互事件绑定，包括：
   * - 登录相关：身份选择、密码输入、登录按钮点击
   * - 登出按钮点击
   * - 消息发送：Enter键发送（Shift+Enter换行）、发送按钮
   * - 输入框自适应高度
   * - 表情面板开关
   * - 图片上传流程：选择→预览→确认发送/取消
   * - 图片查看弹窗：关闭按钮、点击遮罩关闭
   * - 编辑消息弹窗：打开/关闭/保存
   * - 删除消息确认弹窗：打开/关闭/确认
   * - 消息操作委托：查看图片、编辑、删除（使用事件委托）
   * - ESC键全局关闭所有弹窗
   * - 表情面板外部点击自动关闭
   * 
   * @returns {void}
   */
  function bindEvents() {
    const identityCards = $$('.identity-card');
    identityCards.forEach(card => {
      card.addEventListener('click', () => {
        identityCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        clearFieldError('identity');
      });
    });

    $('#loginBtn').addEventListener('click', handleLogin);
    $('#loginPassword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });

    $('#loginPassword').addEventListener('input', () => {
      clearFieldError('password');
    });

    $('#logoutBtn').addEventListener('click', handleLogout);

    $('#sendBtn').addEventListener('click', sendMessage);

    $('#messageInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    $('#messageInput').addEventListener('input', autoResizeInput);

    $('#emojiBtn').addEventListener('click', toggleEmojiPicker);
    $('#closeEmojiPicker').addEventListener('click', () => {
      $('#emojiPicker').style.display = 'none';
    });

    $('#imageBtn').addEventListener('click', () => {
      $('#imageInput').click();
    });

    $('#imageInput').addEventListener('change', handleImageSelect);

    $('#closeImagePreview').addEventListener('click', closeImagePreview);
    $('#cancelImageSend').addEventListener('click', closeImagePreview);
    $('#confirmImageSend').addEventListener('click', sendImageMessage);

    $('#closeImageView').addEventListener('click', () => {
      $('#imageViewOverlay').style.display = 'none';
    });
    $('#imageViewOverlay').addEventListener('click', (e) => {
      if (e.target === $('#imageViewOverlay')) {
        $('#imageViewOverlay').style.display = 'none';
      }
    });

    $('#closeEditModal').addEventListener('click', closeEditModal);
    $('#cancelEdit').addEventListener('click', closeEditModal);
    $('#saveEdit').addEventListener('click', saveEdit);

    $('#closeDeleteModal').addEventListener('click', closeDeleteModal);
    $('#cancelDelete').addEventListener('click', closeDeleteModal);
    $('#confirmDelete').addEventListener('click', confirmDelete);

    // 使用事件委托处理消息气泡上的操作按钮（查看图片、编辑、删除）
    document.addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === 'viewImage') {
          handleViewImage(actionEl.dataset.url);
        } else if (action === 'edit') {
          handleEditMessage(Number(actionEl.dataset.id));
        } else if (action === 'delete') {
          handleDeleteMessage(Number(actionEl.dataset.id));
        }
      }

      // 点击表情面板外部区域时自动关闭面板
      const picker = $('#emojiPicker');
      const emojiBtn = $('#emojiBtn');
      if (picker.style.display !== 'none' &&
        !picker.contains(e.target) &&
        !emojiBtn.contains(e.target)) {
        picker.style.display = 'none';
      }
    });

    // ESC键统一关闭所有弹窗和浮层
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('#emojiPicker').style.display = 'none';
        closeEditModal();
        closeDeleteModal();
        closeImagePreview();
        closeAlbumModal();
        closeAlbumDeleteModal();
        $('#albumViewOverlay').style.display = 'none';
        $('#albumViewImg').src = '';
        $('#albumViewLoading').style.display = 'none';
      }
    });
  }

  /**
   * 更新底部发送者头像和名称显示
   * 
   * 根据当前选中的发送者（selectedSender）更新输入区域旁的头像和文字标识。
   * 小洋使用女生头像，小蔡使用男生头像。
   * 
   * @returns {void}
   */
  function updateSenderDisplay() {
    const display = $('#senderDisplay');
    const avatarSrc = selectedSender === '小洋'
      ? '/images/xiaoyang-avatar.png'
      : '/images/xiaocai-avatar.png';
    display.querySelector('.sender-avatar-small').src = avatarSrc;
    display.querySelector('.sender-name-text').textContent = selectedSender;
  }

  // ==================== 图片上传功能 ====================

  /**
   * 处理文件选择事件——图片预览阶段
   * 
   * 当用户通过<input type="file">选择图片文件后触发此回调：
   * 1. 校验文件类型是否为image/* MIME类型
   * 2. 校验文件大小不超过5MB限制
   * 3. 通过FileReader将文件读取为base64 Data URL
   * 4. 显示图片预览弹窗供用户确认
   * 5. 文件引用暂存至pendingImageFile等待后续发送操作
   * 
   * @param {Event} e - 文件input元素的change事件对象
   * @returns {void}
   */
  function handleImageSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
      showToast('请选择图片或视频文件', 'error');
      return;
    }

    pendingImageFile = file;

    if (isVideo) {
      const previewImg = $('#imagePreviewImg');
      previewImg.style.display = 'none';
      let previewVideo = $('#imagePreviewVideo');
      if (!previewVideo) {
        previewVideo = document.createElement('video');
        previewVideo.id = 'imagePreviewVideo';
        previewVideo.controls = true;
        previewVideo.style.maxWidth = '80vw';
        previewVideo.style.maxHeight = '60vh';
        previewVideo.style.borderRadius = '8px';
        previewImg.parentNode.insertBefore(previewVideo, previewImg);
      }
      previewVideo.style.display = 'block';
      previewVideo.src = URL.createObjectURL(file);
      $('#imagePreviewOverlay').style.display = 'flex';
    } else {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const previewImg = $('#imagePreviewImg');
        previewImg.style.display = 'block';
        let previewVideo = $('#imagePreviewVideo');
        if (previewVideo) { previewVideo.style.display = 'none'; URL.revokeObjectURL(previewVideo.src); }
        previewImg.src = ev.target.result;
        $('#imagePreviewOverlay').style.display = 'flex';
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  }

  /**
   * 关闭图片预览弹窗并清除待发送的文件引用
   * 
   * @returns {void}
   */
  function closeImagePreview() {
    $('#imagePreviewOverlay').style.display = 'none';
    pendingImageFile = null;
  }

  /**
   * 执行图片消息的发送操作
   * 
   * 发送流程分为两步：
   * 第一步：通过FormData multipart/form-data方式上传图片文件到服务端
   * 第二步：用上传返回的图片URL创建一条类型为'image'的消息记录
   * 
   * 发送过程中UI反馈：
   * - 发送期间禁用确认按钮防止重复提交
   * - 按钮文案变为"发送中..."
   * - 成功后清空预览、刷新消息列表、显示成功提示
   * - 无论成功失败都在finally中恢复按钮状态
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function sendImageMessage() {
    if (!pendingImageFile) return;

    const confirmBtn = $('#confirmImageSend');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '上传 0%...';

    try {
      const formData = new FormData();
      formData.append('image', pendingImageFile);

      const uploadRes = await uploadWithProgress(`${API_BASE}/api/upload`, formData, {
        onProgress: (prog) => {
          confirmBtn.textContent = `上传 ${prog.percent}% (${formatSpeed(prog.speed)})`;
        }
      });

      if (!uploadRes.ok) {
        const data = await uploadRes.json();
        showToast(data.error || '上传失败', 'error');
        return;
      }

      confirmBtn.textContent = '发送中...';
      const { url: imageUrl, media_type: mediaType } = await uploadRes.json();

      const msgContent = mediaType === 'video' ? '🎬 视频' : '📷 图片';

      const msgRes = await safeFetch(`${API_BASE}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: msgContent,
          sender: selectedSender,
          message_type: mediaType === 'video' ? 'video' : 'image',
          image_url: imageUrl
        })
      });

      if (!msgRes.ok) {
        const data = await msgRes.json();
        showToast(data.error || '发送失败', 'error');
        return;
      }

      const newMsg = await msgRes.json();
      messagesCache.push(newMsg);
      renderMessages(messagesCache);
      closeImagePreview();
      showToast(mediaType === 'video' ? '视频已发送' : '图片已发送', 'success');
    } catch (err) {
      showToast(`发送失败: ${err.message}`, 'error');
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '发送 💕';
    }
  }

  // ==================== 辅助工具函数 ====================

  /**
   * 自动调整消息输入框的高度
   * 
   * 根据文本内容的实际行数动态调整textarea的高度：
   * - 最小高度固定为40px（单行高度）
   * - 最大高度限制为120px（约3行），超出部分出现滚动条
   * - 每次调整前先重置为最小高度以确保准确计算scrollHeight
   * 
   * @returns {void}
   */
  function autoResizeInput() {
    const input = $('#messageInput');
    input.style.height = '40px';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  /**
   * 显示表单字段的错误提示信息
   * 
   * 根据字段类型（身份选择/密码）定位对应的错误提示DOM元素，
   * 设置错误文案并添加CSS可见性类名和错误样式类名。
   * 
   * @param {string} field - 字段标识符，取值为'identity'或'password'
   * @param {string} message - 要显示的错误提示文案
   * @returns {void}
   */
  function showFieldError(field, message) {
    if (field === 'identity') {
      const el = $('#identityError');
      el.textContent = message;
      el.classList.add('visible');
      $('.login-identity-cards').classList.add('input-error');
    } else if (field === 'password') {
      const el = $('#passwordError');
      el.textContent = message;
      el.classList.add('visible');
      $('#loginPassword').classList.add('input-error');
    }
  }

  /**
   * 清除指定表单字段的错误提示状态
   * 
   * 清空错误文案文本，移除可见性和错误样式类名。
   * 通常在用户重新输入或切换选择时调用。
   * 
   * @param {string} field - 字段标识符，取值为'identity'或'password'
   * @returns {void}
   */
  function clearFieldError(field) {
    if (field === 'identity') {
      const el = $('#identityError');
      el.textContent = '';
      el.classList.remove('visible');
      $('.login-identity-cards').classList.remove('input-error');
    } else if (field === 'password') {
      const el = $('#passwordError');
      el.textContent = '';
      el.classList.remove('visible');
      $('#loginPassword').classList.remove('input-error');
    }
  }

  // ==================== 认证相关功能 ====================

  /**
   * 处理用户登录请求
   * 
   * 登录流程：
   * 1. 清除之前可能残留的字段错误提示
   * 2. 校验用户是否选择了身份卡片（小洋/小蔡）
   * 3. 校验密码是否非空
   * 4. 向服务端发起POST /api/login请求
   * 5. 成功后保存token和用户信息到localStorage
   * 6. 切换到主应用界面并加载消息
   * 
   * UI交互细节：
   * - 登录过程中禁用按钮并显示"登录中..."文案
   * - 密码错误时显示友好的错误提示"你不是我要的宝宝！"
   * - 网络异常时显示通用网络错误提示
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function handleLogin() {
    clearFieldError('identity');
    clearFieldError('password');
    $('#loginError').textContent = '';

    const selectedCard = $('.identity-card.selected');
    if (!selectedCard) {
      showFieldError('identity', '请选择你是哪位宝宝');
      return;
    }

    const username = selectedCard.dataset.username;
    const password = $('#loginPassword').value;

    if (!password) {
      showFieldError('password', '请输入密码');
      return;
    }

    const loginBtn = $('#loginBtn');

    loginBtn.disabled = true;
    loginBtn.textContent = '登录中...';

    try {
      const res = await safeFetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error && (data.error.includes('密码') || data.error.includes('错误'))) {
          showFieldError('password', '你不是我要的宝宝！');
        } else {
          showFieldError('password', '你不是我要的宝宝！');
        }
        return;
      }

      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('loveDiaryToken', authToken);
      localStorage.setItem('loveDiaryUser', JSON.stringify(currentUser));

      showApp();
      loadMessages();
    } catch (err) {
      $('#loginError').textContent = '网络错误，请检查服务器连接';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = '登录 💕';
    }
  }

  /**
   * 处理用户登出操作
   * 
   * 登出清理工作：
   * 1. 通知服务端使token失效（忽略网络错误）
   * 2. 停止消息轮询连接
   * 3. 清空客户端认证状态（token、用户信息、消息缓存）
   * 4. 隐藏新消息指示器
   * 5. 切换回登录界面
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function handleLogout() {
    try {
      await safeFetch(`${API_BASE}/api/logout`, {
        method: 'POST'
      });
    } catch (e) { }

    stopPolling();
    authToken = '';
    currentUser = null;
    localStorage.removeItem('loveDiaryToken');
    localStorage.removeItem('loveDiaryUser');
    messagesCache = [];
    pendingNewMessages = [];
    hideNewMessageIndicator();
    showLogin();
  }

  /**
   * 显示登录界面，隐藏主应用界面
   * 
   * 同时重置所有登录表单状态：
   * - 清除错误提示
   * - 取消所有身份卡片的选中状态
   * 
   * @returns {void}
   */
  function showLogin() {
    $('#loginOverlay').style.display = 'flex';
    $('#app').style.display = 'none';
    $('#loginError').textContent = '';
    clearFieldError('identity');
    clearFieldError('password');
    const identityCards = $$('.identity-card');
    identityCards.forEach(c => c.classList.remove('selected'));
  }

  /**
   * 显示主应用界面，隐藏登录界面
   * 
   * 初始化应用状态：
   * - 设置顶部栏显示当前用户昵称
   * - 根据用户身份设置对应的头像
   * - 获取CSRF令牌
   * - 获取未读消息数量
   * 
   * @returns {void}
   */
  function showApp() {
    $('#loginOverlay').style.display = 'none';
    $('#app').style.display = 'flex';
    if (currentUser) {
      $('#currentUser').textContent = currentUser.displayName;
      selectedSender = currentUser.displayName;
      const headerAvatar = $('#headerAvatar');
      if (headerAvatar) {
        const avatarSrc = currentUser.displayName === '小洋'
          ? '/images/xiaoyang-avatar.png'
          : '/images/xiaocai-avatar.png';
        headerAvatar.src = avatarSrc;
      }
    }
    fetchCsrfToken();
    fetchImageToken();
    fetchUnreadCount();
  }

  // ==================== 消息加载与渲染 ====================

  /**
   * 从服务端加载消息列表
   * 
   * 加载流程：
   * 1. 显示加载指示器（loading spinner）
   * 2. GET请求最近100条消息（按时间倒序）
   * 3. 401响应表示token失效，触发登出
   * 4. 成功后渲染消息列表、启动轮询、获取未读数
   * 5. 记录本次加载时间作为已读检查基准时间点
   * 6. 网络异常时显示错误占位UI
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function loadMessages() {
    const indicator = $('#loadingIndicator');
    const container = $('#messagesContainer');
    indicator.style.display = 'flex';

    try {
      await fetchImageToken();
      const res = await safeFetch(`${API_BASE}/api/messages?limit=100`);

      if (res.status === 401) {
        handleLogout();
        return;
      }

      const data = await res.json();
      messagesCache = data;
      renderMessages(data);
      startPolling();
      fetchUnreadCount();
      lastReadCheckTime = new Date().toISOString();
    } catch (err) {
      showToast('加载消息失败', 'error');
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-emoji">😢</div>
          <div class="empty-state-text">加载失败</div>
          <div class="empty-state-subtext">请检查网络连接后重试</div>
        </div>
      `;
    } finally {
      indicator.style.display = 'none';
    }
  }

  /**
   * 渲染消息列表到DOM
   * 
   * 渲染规则：
   * - 消息按日期分组，日期变更处插入日期分隔线
   * - 不同发送者的消息使用不同的CSS样式类（xiaozhong/xiaocai）
   * - 未读消息添加高亮样式类
   * - 图片类型消息渲染为img标签，支持点击放大查看
   * - 已编辑消息显示"(已编辑)"标记
   * - 每条消息附带已读状态标签（未读/已读+时间）
   * - 消息底部附带编辑和删除操作按钮
   * 
   * @param {Array<Object>} messages - 消息对象数组，每条消息包含：
   *   id, sender, content, created_at, updated_at, is_read, read_at,
   *   message_type, image_url
   * @returns {void}
   */
  function renderMessages(messages) {
    const container = $('#messagesContainer');

    if (!messages || messages.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-emoji">💕</div>
          <div class="empty-state-text">还没有消息哦</div>
          <div class="empty-state-subtext">写下第一条甜蜜的话吧~</div>
        </div>
      `;
      return;
    }

    let html = '';
    let lastDate = '';

    messages.forEach(msg => {
      const msgDate = formatDate(msg.created_at);
      if (msgDate !== lastDate) {
        html += `<div class="date-divider"><span>${msgDate}</span></div>`;
        lastDate = msgDate;
      }

      const isUnread = !msg.is_read;
      const senderClass = msg.sender === '小洋' ? 'sender-xiaozhong' : 'sender-xiaocai';
      const unreadClass = isUnread ? ' unread-message' : '';
      const senderAvatar = msg.sender === '小洋'
        ? '<img class="message-avatar" src="/images/xiaoyang-avatar.png" alt="小洋">'
        : '<img class="message-avatar" src="/images/xiaocai-avatar.png" alt="小蔡">';
      const time = formatTime(msg.created_at);
      const edited = msg.updated_at !== msg.created_at ? ' <span class="message-edited">(已编辑)</span>' : '';

      let bubbleContent;
      if (msg.message_type === 'image' && msg.image_url) {
        bubbleContent = `<img class="message-image" src="${escapeHtml(authImageUrl(msg.image_url))}" alt="图片" data-action="viewImage" data-url="${escapeHtml(authImageUrl(msg.image_url))}" loading="lazy">`;
        if (msg.content && msg.content !== '📷 图片') {
          const escapedContent = escapeHtml(msg.content).replace(/\n/g, '<br>');
          bubbleContent += `<div class="message-image-caption">${escapedContent}</div>`;
        }
      } else {
        const escapedContent = escapeHtml(msg.content).replace(/\n/g, '<br>');
        bubbleContent = escapedContent;
      }

      let statusHtml = '';
      if (isUnread) {
        statusHtml = `<div class="message-read-status read-status-unread"><span class="unread-dot"></span>未读</div>`;
      } else if (msg.read_at) {
        statusHtml = `<div class="message-read-status read-status-read">✓ 已读 ${formatReadTime(msg.read_at)}</div>`;
      }

      html += `
        <div class="message-wrapper ${senderClass}${unreadClass}" data-id="${msg.id}" data-read="${msg.is_read ? 1 : 0}" data-sender="${escapeHtml(msg.sender)}">
          <div class="message-sender">${senderAvatar} ${msg.sender}</div>
          <div class="message-bubble">${bubbleContent}</div>
          <div class="message-time">${time}${edited}</div>
          ${statusHtml}
          <div class="message-actions">
            <button class="message-action-btn edit-btn" data-action="edit" data-id="${msg.id}">✏️ 编辑</button>
            <button class="message-action-btn delete-btn" data-action="delete" data-id="${msg.id}">🗑️ 删除</button>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
    setupReadObserver();
    scrollToBottom();
  }

  /**
   * 打开图片全屏查看弹窗
   * 
   * @param {string} url - 已包含认证token的图片完整URL
   * @returns {void}
   */
  function handleViewImage(url) {
    $('#imageViewImg').src = url;
    $('#imageViewOverlay').style.display = 'flex';
  }

  /**
   * 打开消息编辑弹窗
   * 
   * 从消息缓存中查找对应ID的消息记录，
   * 将其内容填充到编辑框并显示编辑弹窗。
   * 
   * @param {number} id - 要编辑的消息ID
   * @returns {void}
   */
  function handleEditMessage(id) {
    const msg = messagesCache.find(m => m.id === id);
    if (!msg) return;

    editingMessageId = id;
    $('#editContent').value = msg.content;
    $('#editModal').style.display = 'flex';
    $('#editContent').focus();
  }

  /**
   * 打开消息删除确认弹窗
   * 
   * @param {number} id - 要删除的消息ID
   * @returns {void}
   */
  function handleDeleteMessage(id) {
    deletingMessageId = id;
    $('#deleteConfirmModal').style.display = 'flex';
  }

  /**
   * 关闭消息编辑弹窗并重置编辑状态
   * 
   * @returns {void}
   */
  function closeEditModal() {
    $('#editModal').style.display = 'none';
    editingMessageId = null;
  }

  /**
   * 保存消息编辑内容到服务端
   * 
   * 流程：
   * 1. 校验编辑内容非空
   * 2. PUT请求更新消息内容
   * 3. 成功后更新本地缓存并重新渲染消息列表
   * 4. 关闭编辑弹窗并显示成功提示
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function saveEdit() {
    if (!editingMessageId) return;

    const content = $('#editContent').value.trim();
    if (!content) {
      showToast('消息内容不能为空', 'error');
      return;
    }

    try {
      const res = await safeFetch(`${API_BASE}/api/messages/${editingMessageId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content })
      });

      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || '编辑失败', 'error');
        return;
      }

      const updatedMsg = await res.json();
      const idx = messagesCache.findIndex(m => m.id === editingMessageId);
      if (idx !== -1) {
        messagesCache[idx] = updatedMsg;
      }
      renderMessages(messagesCache);
      closeEditModal();
      showToast('消息已更新', 'success');
    } catch (err) {
      showToast('编辑失败', 'error');
    }
  }

  /**
   * 关闭消息删除确认弹窗并重置删除状态
   * 
   * @returns {void}
   */
  function closeDeleteModal() {
    $('#deleteConfirmModal').style.display = 'none';
    deletingMessageId = null;
  }

  /**
   * 确认并执行消息删除操作
   * 
   * DELETE请求删除服务端消息记录，
   * 成功后从本地缓存移除该消息并重新渲染列表。
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function confirmDelete() {
    if (!deletingMessageId) return;

    try {
      const res = await safeFetch(`${API_BASE}/api/messages/${deletingMessageId}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || '删除失败', 'error');
        return;
      }

      messagesCache = messagesCache.filter(m => m.id !== deletingMessageId);
      renderMessages(messagesCache);
      closeDeleteModal();
      showToast('消息已删除', 'success');
    } catch (err) {
      showToast('删除失败', 'error');
    }
  }

  /**
   * 发送纯文本消息
   * 
   * 从输入框获取内容，校验非空后POST到服务端。
   * 成功后将新消息追加到本地缓存并重新渲染。
   * 发送完成后清空输入框并聚焦以便继续输入。
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function sendMessage() {
    const input = $('#messageInput');
    const content = input.value.trim();
    const sender = selectedSender;

    if (!content) return;

    const sendBtn = $('#sendBtn');
    sendBtn.disabled = true;

    try {
      const res = await safeFetch(`${API_BASE}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content, sender })
      });

      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || '发送失败', 'error');
        return;
      }

      const newMsg = await res.json();
      messagesCache.push(newMsg);
      renderMessages(messagesCache);

      input.value = '';
      input.style.height = '40px';
      input.focus();
    } catch (err) {
      showToast('发送失败，请检查网络', 'error');
    } finally {
      sendBtn.disabled = false;
    }
  }

  // ==================== 滚动检测 ====================

  /**
   * 初始化聊天区域的滚动位置检测机制
   * 
   * 监听chatArea的scroll事件（带50ms防抖），
   * 判断当前滚动位置是否接近底部（距底部<80px）：
   * - 接近底部且有待显示的新消息时，立即追加上新消息
   * - 否则将新消息暂存到pendingNewMessages队列
   * 
   * @returns {void}
   */
  function initScrollDetection() {
    const chatArea = $('#chatArea');
    let scrollTimer;
    chatArea.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const threshold = 80;
        isAtBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < threshold;
        if (isAtBottom && pendingNewMessages.length > 0) {
          appendNewMessages(pendingNewMessages);
          pendingNewMessages = [];
          hideNewMessageIndicator();
        }
      }, 50);
    });
  }

  // ==================== 消息轮询 ====================

  /**
   * 启动长轮询消息同步
   * 
   * 先停止已有轮询（如有），然后设置isPolling标志并开始第一次doPoll调用。
   * 
   * @returns {void}
   */
  function startPolling() {
    stopPolling();
    isPolling = true;
    doPoll();
  }

  /**
   * 停止消息轮询
   * 
   * 重置轮询标志并通过AbortController中断正在进行的HTTP请求。
   * 
   * @returns {void}
   */
  function stopPolling() {
    isPolling = false;
    if (pollAbortController) {
      pollAbortController.abort();
      pollAbortController = null;
    }
  }

  /**
   * 执行一次长轮询请求
   * 
   * 轮询机制说明：
   * - 服务端最长保持连接25秒，有新消息或已读变化时立即返回
   * - 客户端收到响应后立即发起下一次轮询
   * - 使用after_id参数实现增量拉取（只获取比最后一条更新的消息）
   * - 使用last_read_check参数让服务端推送期间的已读状态变化
   * 
   * 收到响应后的处理：
   * 1. 新消息：去重后追加到缓存，根据滚动位置决定立即显示或暂存
   * 2. 已读变化：更新缓存数据和DOM显示，刷新未读计数
   * 3. 网络异常（非主动取消）：3秒后自动重试
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function doPoll() {
    if (!isPolling || !authToken) return;

    try {
      pollAbortController = new AbortController();
      const lastId = messagesCache.length > 0 ? messagesCache[messagesCache.length - 1].id : 0;
      const readParam = lastReadCheckTime ? `&last_read_check=${encodeURIComponent(lastReadCheckTime)}` : '';

      const res = await safeFetch(`${API_BASE}/api/messages/poll?after_id=${lastId}&timeout=25000${readParam}`, {
        signal: pollAbortController.signal
      });

      if (!isPolling) return;

      if (res.status === 401) {
        stopPolling();
        handleLogout();
        return;
      }

      const data = await res.json();
      const newMessages = data.new_messages || data;
      const readChanges = data.read_changes || null;

      if (data.server_time) {
        lastReadCheckTime = data.server_time;
      }

      // 处理新到达的消息
      if (newMessages && newMessages.length > 0) {
        const trulyNew = newMessages.filter(msg => !messagesCache.find(m => m.id === msg.id));
        trulyNew.forEach(msg => messagesCache.push(msg));

        if (trulyNew.length > 0) {
          if (isAtBottom) {
            appendNewMessages(trulyNew);
            scrollToBottom(true);
          } else {
            pendingNewMessages.push(...trulyNew);
            showNewMessageIndicator(pendingNewMessages.length);
          }
          fetchUnreadCount();
        }
      }

      // 处理其他用户的已读状态变化
      if (readChanges && readChanges.length > 0) {
        readChanges.forEach(change => {
          const msg = messagesCache.find(m => m.id === change.id);
          if (msg) {
            msg.is_read = change.is_read;
            msg.read_at = change.read_at;
          }
          const el = $(`.message-wrapper[data-id="${change.id}"]`);
          if (el) {
            el.dataset.read = change.is_read ? '1' : '0';
            el.classList.toggle('unread-message', !change.is_read);
            let statusEl = el.querySelector('.message-read-status');
            if (!statusEl) {
              statusEl = document.createElement('div');
              const timeEl = el.querySelector('.message-time');
              if (timeEl && timeEl.nextSibling) {
                timeEl.parentNode.insertBefore(statusEl, timeEl.nextSibling);
              } else if (timeEl) {
                timeEl.parentNode.appendChild(statusEl);
              }
            }
            if (change.is_read) {
              statusEl.className = 'message-read-status read-status-read read-status-just-changed';
              statusEl.innerHTML = `✓ 已读 ${formatReadTime(change.read_at)}`;
            } else {
              statusEl.className = 'message-read-status read-status-unread';
              statusEl.innerHTML = '<span class="unread-dot"></span>未读';
            }
          }
        });
        fetchUnreadCount();
      }

      doPoll();
    } catch (err) {
      if (err.name !== 'AbortError') {
        setTimeout(doPoll, 3000);
      }
    }
  }

  /**
   * 追加新消息到聊天区域DOM（不重新渲染整个列表）
   * 
   * 与renderMessages不同，此函数只插入新增消息的HTML片段，
   * 并配合CSS动画实现新消息的入场效果（淡入+轻微上滑）。
   * 
   * @param {Array<Object>} newMessages - 新到达的消息对象数组
   * @returns {void}
   */
  function appendNewMessages(newMessages) {
    const container = $('#messagesContainer');
    let lastDate = '';
    const existingDividers = container.querySelectorAll('.date-divider');
    if (existingDividers.length > 0) {
      lastDate = existingDividers[existingDividers.length - 1].textContent.trim();
    }

    let html = '';

    newMessages.forEach((msg, index) => {
      const msgDate = formatDate(msg.created_at);
      if (msgDate !== lastDate) {
        html += `<div class="date-divider"><span>${msgDate}</span></div>`;
        lastDate = msgDate;
      }

      const isUnread = !msg.is_read;
      const senderClass = msg.sender === '小洋' ? 'sender-xiaozhong' : 'sender-xiaocai';
      const unreadClass = isUnread ? ' unread-message' : '';
      const senderAvatar = msg.sender === '小洋'
        ? '<img class="message-avatar" src="/images/xiaoyang-avatar.png" alt="小洋">'
        : '<img class="message-avatar" src="/images/xiaocai-avatar.png" alt="小蔡">';
      const time = formatTime(msg.created_at);
      const edited = msg.updated_at !== msg.created_at ? ' <span class="message-edited">(已编辑)</span>' : '';

      let bubbleContent;
      if (msg.message_type === 'image' && msg.image_url) {
        bubbleContent = `<img class="message-image" src="${escapeHtml(authImageUrl(msg.image_url))}" alt="图片" data-action="viewImage" data-url="${escapeHtml(authImageUrl(msg.image_url))}" loading="lazy">`;
        if (msg.content && msg.content !== '📷 图片') {
          const escapedContent = escapeHtml(msg.content).replace(/\n/g, '<br>');
          bubbleContent += `<div class="message-image-caption">${escapedContent}</div>`;
        }
      } else {
        const escapedContent = escapeHtml(msg.content).replace(/\n/g, '<br>');
        bubbleContent = escapedContent;
      }

      let statusHtml = '';
      if (isUnread) {
        statusHtml = `<div class="message-read-status read-status-unread"><span class="unread-dot"></span>未读</div>`;
      } else if (msg.read_at) {
        statusHtml = `<div class="message-read-status read-status-read">✓ 已读 ${formatReadTime(msg.read_at)}</div>`;
      }

      html += `
        <div class="message-wrapper ${senderClass} message-new-arrive${unreadClass}" data-id="${msg.id}" data-read="${msg.is_read ? 1 : 0}" data-sender="${escapeHtml(msg.sender)}">
          <div class="message-sender">${senderAvatar} ${msg.sender}</div>
          <div class="message-bubble">${bubbleContent}</div>
          <div class="message-time">${time}${edited}</div>
          ${statusHtml}
          <div class="message-actions">
            <button class="message-action-btn edit-btn" data-action="edit" data-id="${msg.id}">✏️ 编辑</button>
            <button class="message-action-btn delete-btn" data-action="delete" data-id="${msg.id}">🗑️ 删除</button>
          </div>
        </div>
      `;
    });

    container.insertAdjacentHTML('beforeend', html);

    requestAnimationFrame(() => {
      $$('.message-new-arrive').forEach(el => {
        el.classList.add('message-new-animate');
        el.addEventListener('animationend', () => {
          el.classList.remove('message-new-arrive', 'message-new-animate');
        }, { once: true });
      });
    });

    setupReadObserver();
  }

  /**
   * 显示"X条新消息"浮动指示器
   * 
   * 当用户不在聊天底部且有新消息到达时显示此指示器。
   * 点击指示器可将暂存的新消息追加到列表并滚动到底部。
   * 
   * @param {number} count - 当前待显示的新消息数量
   * @returns {void}
   */
  function showNewMessageIndicator(count) {
    let indicator = $('#newMessageIndicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'newMessageIndicator';
      indicator.className = 'new-message-indicator';
      indicator.innerHTML = '<span class="indicator-text"></span>';
      indicator.addEventListener('click', () => {
        if (pendingNewMessages.length > 0) {
          appendNewMessages(pendingNewMessages);
          pendingNewMessages = [];
          hideNewMessageIndicator();
          scrollToBottom(true);
        }
      });
      document.querySelector('.chat-area').appendChild(indicator);
    }
    indicator.querySelector('.indicator-text').textContent = `${count} 条新消息 💕`;
    indicator.style.display = 'flex';
    indicator.classList.add('indicator-bounce-in');
  }

  /**
   * 隐藏新消息浮动指示器
   * 
   * @returns {void}
   */
  function hideNewMessageIndicator() {
    const indicator = $('#newMessageIndicator');
    if (indicator) {
      indicator.style.display = 'none';
      indicator.classList.remove('indicator-bounce-in');
    }
  }

  /**
   * 切换表情选择器的显示/隐藏状态
   * 
   * @returns {void}
   */
  function toggleEmojiPicker() {
    const picker = $('#emojiPicker');
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  }

  /**
   * 将聊天区域滚动到底部
   * 
   * @param {boolean} [smooth=true] - 是否使用平滑滚动动画，默认true
   * @returns {void}
   */
  function scrollToBottom(smooth = true) {
    const chatArea = $('#chatArea');
    if (smooth) {
      chatArea.scrollTo({
        top: chatArea.scrollHeight,
        behavior: 'smooth'
      });
    } else {
      requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
      });
    }
  }

  // ==================== Toast提示 ====================

  /**
   * 显示轻量级Toast通知提示
   * 
   * 特性：
   * - 自动2.5秒后消失
   * - 重复调用会重置计时器
   * - 支持不同类型（success/error）对应不同颜色样式
   * 
   * @param {string} message - 提示文案内容
   * @param {string} [type='success'] - 提示类型，可选'success'或'error'
   * @returns {void}
   */
  function showToast(message, type = 'success') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast toast-${type}`;
    toast.style.display = 'block';

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.display = 'none';
    }, 2500);
  }

  // ==================== 格式化工具函数 ====================

  /**
   * HTML特殊字符转义，防止XSS注入攻击
   * 
   * 利用浏览器DOM API的textContent属性实现安全的转义，
   * 将<, >, &, "等字符转换为对应的HTML实体。
   * 
   * @param {string} text - 需要转义的原始文本
   * @returns {string} 转义后的安全HTML字符串
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * 将ISO日期字符串格式化为中文友好日期标签
   * 
   * 规则：
   * - 今天 → "今天"
   * - 昨天 → "昨天"
   * 7天内 → "N天前"
   * 其他 → "YYYY-MM-DD"
   * 
   * @param {string} dateStr - ISO格式日期字符串（如"2024-01-15T08:30:00"）
   * @returns {string} 格式化后的中文日期标签
   */
  function formatDate(dateStr) {
    const date = new Date(dateStr + 'Z');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diff = today - msgDay;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days}天前`;

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  /**
   * 将ISO日期字符串格式化为详细时间显示
   * 
   * 规则：
   * - 今天 → "今日 HH:mm"
   * - 其他日期 → "YYYY-MM-DD HH:mm"
   * 
   * @param {string} dateStr - ISO格式日期字符串
   * @returns {string} 格式化的时间字符串
   */
  function formatTime(dateStr) {
    const date = new Date(dateStr + 'Z');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const isToday = today.getTime() === msgDay.getTime();
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (isToday) return `今日 ${hm}`;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hm}`;
  }

  /**
   * 格式化已读时间为简短的时间显示（仅HH:mm）
   * 
   * 兼容两种日期格式：
   * - ISO格式含T分隔符（如"2024-01-15T08:30:00"）
   * - 不含T分隔符的格式（需手动补Z后缀）
   * 
   * @param {string|undefined|null} dateStr - 已读时间字符串，可为空
   * @returns {string} 格式化为"HH:mm"的时间字符串；无效输入返回空串
   */
  function formatReadTime(dateStr) {
    if (!dateStr) return '';
    let date;
    if (typeof dateStr === 'string' && dateStr.includes('T')) {
      date = new Date(dateStr);
    } else {
      date = new Date(dateStr + 'Z');
    }
    if (isNaN(date.getTime())) return '';
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return hm;
  }

  // ==================== 已读回执机制 ====================

  /** 待标记为已读的消息ID集合（尚未发送到服务端的） */
  let pendingMarkAsReadIds = [];

  /** 已读标记定时器引用，用于防抖合并多次标记请求 */
  let markAsReadTimer = null;

  /**
   * 设置IntersectionObserver监控未读消息的可见性
   * 
   * 原理：当对方发送的未读消息进入可视区域（至少30%可见）时，
   * 自动将该消息标记为已读。
   * 只监控非自己发送的未读消息（data-read="0"且data-sender != currentSender）。
   * 
   * 每次调用先断开旧observer再创建新的，确保监控集合是最新的。
   * 
   * @returns {void}
   */
  function setupReadObserver() {
    if (readObserver) {
      readObserver.disconnect();
    }
    const currentSender = selectedSender || currentUser?.displayName;
    readObserver = new IntersectionObserver((entries) => {
      const unreadIds = [];
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          if (el.dataset.read === '0' && el.dataset.sender !== currentSender) {
            unreadIds.push(Number(el.dataset.id));
            el.dataset.read = '1';
          }
        }
      });
      if (unreadIds.length > 0) {
        pendingMarkAsReadIds.push(...unreadIds);
        scheduleMarkAsRead();
      }
    }, { root: $('#chat-area'), threshold: 0.3 });

    $$('.message-wrapper[data-read="0"]').forEach(el => {
      if (el.dataset.sender !== currentSender) {
        readObserver.observe(el);
      }
    });
  }

  /**
   * 调度已读标记请求（500ms防抖）
   * 
   * 多个消息几乎同时进入可视区域时，不会每次都立即发送请求，
   * 而是等待500ms收集完一批后再一次性发送，减少网络开销。
   * 
   * @returns {void}
   */
  function scheduleMarkAsRead() {
    if (markAsReadTimer) return;
    markAsReadTimer = setTimeout(async () => {
      markAsReadTimer = null;
      const idsToMark = [...new Set(pendingMarkAsReadIds)];
      pendingMarkAsReadIds = [];
      if (idsToMark.length === 0) return;
      await markMessagesAsRead(idsToMark);
    }, 500);
  }

  /**
   * 向服务端发送批量已读标记请求
   * 
   * POST /api/messages/read 携带消息ID数组，
   * 成功后更新本地缓存和DOM显示状态，刷新未读计数。
   * 若请求失败则将ID重新放回待发送队列等待下次重试。
   * 
   * @async
   * @param {number[]} ids - 需要标记为已读的消息ID数组
   * @returns {Promise<void>}
   */
  async function markMessagesAsRead(ids) {
    try {
      const res = await safeFetch(`${API_BASE}/api/messages/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_ids: ids })
      });
      if (!res.ok) return;
      const data = await res.json();

      ids.forEach(id => {
        const msg = messagesCache.find(m => m.id === id);
        if (msg) {
          msg.is_read = 1;
          msg.read_at = data.read_at;
        }
      });

      lastReadCheckTime = new Date().toISOString();
      updateUnreadCountDisplay(-data.updated);

      $$('.message-wrapper.unread-message').forEach(el => {
        const id = Number(el.dataset.id);
        if (ids.includes(id)) {
          el.classList.remove('unread-message');
          const statusEl = el.querySelector('.message-read-status');
          if (statusEl) {
            statusEl.className = 'message-read-status read-status-read';
            statusEl.innerHTML = `✓ 已读 ${formatReadTime(data.read_at)}`;
          }
        }
      });
    } catch (e) {
      pendingMarkAsReadIds.push(...ids);
      scheduleMarkAsRead();
    }
  }

  /**
   * 从服务端获取当前未读消息总数
   * 
   * @async
   * @returns {Promise<void>} 结果写入全局unreadCount变量并更新角标显示
   */
  async function fetchUnreadCount() {
    try {
      const res = await safeFetch(`${API_BASE}/api/messages/unread-count`);
      if (res.ok) {
        const data = await res.json();
        unreadCount = data.unread_count;
        updateUnreadBadge(unreadCount);
      }
    } catch (e) {}
  }

  /**
   * 更新头部导航栏的未读消息角标显示
   * 
   * 角标特性：
   * - 数量>99时显示"99+"
   * - 数量为0时隐藏角标
   * - 首次调用时动态创建角标DOM元素
   * 
   * @param {number} count - 未读消息数量
   * @returns {void}
   */
  function updateUnreadBadge(count) {
    let badge = $('#unreadBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'unreadBadge';
      badge.className = 'unread-badge hidden';
      const headerRight = $('.header-right');
      if (headerRight) {
        const area = document.createElement('div');
        area.className = 'header-unread-area';
        area.appendChild(badge);
        headerRight.insertBefore(area, headerRight.firstChild);
      }
    }
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  /**
   * 根据增量值更新未读计数并刷新角标
   * 
   * @param {number} delta - 变化量（正数增加，负数减少），结果不低于0
   * @returns {void}
   */
  function updateUnreadCountDisplay(delta) {
    unreadCount = Math.max(0, unreadCount + delta);
    updateUnreadBadge(unreadCount);
  }

  // ==================== 相册功能模块 ====================

  /** 当前待删除的相册照片ID */
  let deletingAlbumPhotoId = null;

  /**
   * 初始化相册功能模块的所有事件绑定
   * 
   * 包括：打开/关闭相册弹窗、图片上传、照片删除确认、
   *       大图查看（原图模式）、遮罩层点击关闭等
   * 
   * @returns {void}
   */
  function initAlbum() {
    $('#albumBtn').addEventListener('click', openAlbumModal);
    $('#closeAlbumModal').addEventListener('click', closeAlbumModal);
    $('#albumImageInput').addEventListener('change', handleAlbumUpload);
    $('#albumModal').addEventListener('click', (e) => {
      if (e.target === $('#albumModal')) closeAlbumModal();
    });
    $('#closeAlbumDeleteModal').addEventListener('click', closeAlbumDeleteModal);
    $('#cancelAlbumDelete').addEventListener('click', closeAlbumDeleteModal);
    $('#confirmAlbumDelete').addEventListener('click', confirmAlbumDelete);
    $('#closeAlbumView').addEventListener('click', () => {
      $('#albumViewOverlay').style.display = 'none';
      $('#albumViewImg').src = '';
      $('#albumViewLoading').style.display = 'none';
      const viewVideo = $('#albumViewVideo');
      if (viewVideo) { viewVideo.pause(); viewVideo.src = ''; viewVideo.style.display = 'none'; }
    });
    $('#albumViewOverlay').addEventListener('click', (e) => {
      if (e.target === $('#albumViewOverlay')) {
        $('#albumViewOverlay').style.display = 'none';
        $('#albumViewImg').src = '';
        $('#albumViewLoading').style.display = 'none';
        const viewVideo = $('#albumViewVideo');
        if (viewVideo) { viewVideo.pause(); viewVideo.src = ''; viewVideo.style.display = 'none'; }
      }
    });
  }

  /**
   * 打开相册弹窗并加载照片列表
   * 
   * @returns {void}
   */
  function openAlbumModal() {
    $('#albumModal').style.display = 'flex';
    loadAlbumPhotos();
  }

  /**
   * 关闭相册弹窗
   * 
   * @returns {void}
   */
  function closeAlbumModal() {
    $('#albumModal').style.display = 'none';
  }

  /**
   * 从服务端加载相册照片列表
   * 
   * 加载过程中显示loading状态，成功后调用renderAlbumPhotos渲染，
   * 失败则显示错误提示。
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function loadAlbumPhotos() {
    const grid = $('#albumGrid');
    grid.innerHTML = '<div class="album-empty"><div class="album-empty-emoji"><div class="loading-spinner" style="margin:0 auto;"></div></div><div class="album-empty-text">加载中...</div></div>';

    try {
      await fetchImageToken();
      const res = await safeFetch(`${API_BASE}/api/album`);
      if (!res.ok) {
        showToast('获取相册失败', 'error');
        grid.innerHTML = '<div class="album-empty"><div class="album-empty-emoji">😢</div><div class="album-empty-text">加载失败</div></div>';
        return;
      }

      const photos = await res.json();
      renderAlbumPhotos(photos);
    } catch (err) {
      showToast('获取相册失败', 'error');
      grid.innerHTML = '<div class="album-empty"><div class="album-empty-emoji">😢</div><div class="album-empty-text">加载失败</div></div>';
    }
  }

  /**
   * 渲染相册照片网格视图（缩略图浏览模式）
   * 
   * 核心优化：每张照片默认使用缩略图URL（thumbnail_url）进行展示，
   * 仅在用户点击某张照片进入详情查看模式时才加载原始分辨率版本。
   * 这样可以大幅减少页面初次加载的网络流量和内存占用。
   * 
   * 渲染内容包括：
   * - 缩略图图片（带lazy loading优化）
   * - 删除按钮（悬浮显示）
   * - 上传者和日期信息
   * - 点击事件：显示加载指示器→加载原图→淡入显示
   * 
   * @param {Array<Object>} photos - 照片对象数组，每项包含：
   *   id, filename, original_name, file_size, uploaded_by, created_at,
   *   url（原图URL）, thumbnail_url（缩略图URL）
   * @returns {void}
   */
  function renderAlbumPhotos(photos) {
    const grid = $('#albumGrid');
    const countEl = $('#albumCount');
    countEl.textContent = photos.length > 0 ? `共 ${photos.length} 张` : '';

    if (!photos || photos.length === 0) {
      grid.innerHTML = `
        <div class="album-empty">
          <div class="album-empty-emoji">📷</div>
          <div class="album-empty-text">还没有照片哦</div>
          <div class="album-empty-subtext">上传第一张照片记录甜蜜瞬间吧~</div>
        </div>
      `;
      return;
    }

    let html = '<div class="album-grid-inner">';
    photos.forEach(photo => {
      const date = new Date(photo.created_at + 'Z');
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
      const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const isVideo = photo.media_type === 'video';

      const thumbnailUrl = photo.thumbnail_url
        ? authImageUrl(photo.thumbnail_url)
        : authImageUrl(photo.url);
      const originalUrl = authImageUrl(photo.url);

      if (isVideo) {
        html += `
          <div class="album-photo-card" data-id="${photo.id}" data-original-url="${escapeHtml(originalUrl)}" data-media-type="video">
            <div class="album-video-wrapper">
              <img src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(photo.original_name)}" loading="lazy" class="album-video-thumb">
              <div class="album-video-play-icon">▶</div>
            </div>
            <button class="album-photo-delete" data-album-delete="${photo.id}" title="删除">✕</button>
            <div class="album-photo-info">
              <div class="photo-uploader">${escapeHtml(photo.uploaded_by)}</div>
              <div class="photo-date">${dateStr} ${timeStr}</div>
            </div>
          </div>
        `;
      } else {
        html += `
          <div class="album-photo-card" data-id="${photo.id}" data-original-url="${escapeHtml(originalUrl)}" data-media-type="image">
            <img src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(photo.original_name)}" loading="lazy">
            <button class="album-photo-delete" data-album-delete="${photo.id}" title="删除">✕</button>
            <div class="album-photo-info">
              <div class="photo-uploader">${escapeHtml(photo.uploaded_by)}</div>
              <div class="photo-date">${dateStr} ${timeStr}</div>
            </div>
          </div>
        `;
      }
    });
    html += '</div>';
    grid.innerHTML = html;

    grid.querySelectorAll('.album-photo-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-album-delete]')) return;
        const originalUrl = card.dataset.originalUrl;
        const mediaType = card.dataset.mediaType || 'image';
        const loadingEl = $('#albumViewLoading');

        if (mediaType === 'video') {
          const viewImg = $('#albumViewImg');
          viewImg.style.display = 'none';
          let viewVideo = $('#albumViewVideo');
          if (!viewVideo) {
            viewVideo = document.createElement('video');
            viewVideo.id = 'albumViewVideo';
            viewVideo.controls = true;
            viewVideo.autoplay = true;
            viewVideo.style.maxWidth = '90vw';
            viewVideo.style.maxHeight = '85vh';
            viewVideo.style.borderRadius = '8px';
            $('#albumViewOverlay').querySelector('.image-view-container').insertBefore(viewVideo, viewImg);
          }
          viewVideo.style.display = 'block';
          loadingEl.style.display = 'flex';
          viewVideo.onloadeddata = () => { loadingEl.style.display = 'none'; };
          viewVideo.onerror = () => { loadingEl.style.display = 'none'; };
          viewVideo.src = originalUrl;
          $('#albumViewOverlay').style.display = 'flex';
        } else {
          let viewVideo = $('#albumViewVideo');
          if (viewVideo) { viewVideo.style.display = 'none'; viewVideo.src = ''; }
          const viewImg = $('#albumViewImg');
          viewImg.style.display = 'block';
          loadingEl.style.display = 'flex';
          viewImg.style.opacity = '0';
          viewImg.onload = () => {
            loadingEl.style.display = 'none';
            viewImg.style.opacity = '1';
            viewImg.style.transition = 'opacity 0.3s ease';
          };
          viewImg.onerror = () => {
            loadingEl.style.display = 'none';
            viewImg.style.opacity = '1';
          };
          viewImg.src = originalUrl;
          $('#albumViewOverlay').style.display = 'flex';
        }
      });
    });

    // 绑定删除按钮事件（阻止冒泡避免触发卡片的查看事件）
    grid.querySelectorAll('[data-album-delete]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.albumDelete);
        handleAlbumDelete(id);
      });
    });
  }

  /**
   * 处理相册媒体批量上传（支持图片+视频）
   *
   * 支持一次选择多张图片/视频，逐个上传到服务端相册接口。
   * 上传过程显示真实字节级进度条（基于XMLHttpRequest upload.onprogress）。
   *
   * 进度条逻辑：
   * - 总进度 = 所有文件已上传字节数之和 / 所有文件总大小
   * - 每个文件上传时实时更新：当前文件名、百分比、传输速度
   *
   * 全部完成后汇总成功/失败数量并给出Toast提示，
   * 有成功时自动刷新相册列表。
   *
   * @param {Event} e - 文件input元素的change事件对象
   * @returns {Promise<void>}
   */
  async function handleAlbumUpload(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    const progressContainer = $('#albumUploadProgress');
    const progressBar = $('#albumProgressBar');
    const progressText = $('#albumProgressText');

    progressContainer.style.display = 'flex';
    progressBar.style.width = '0%';
    progressText.textContent = '准备上传...';

    const validFiles = files.filter(f => {
      return f.type.startsWith('image/') || f.type.startsWith('video/');
    });

    if (validFiles.length === 0) {
      progressContainer.style.display = 'none';
      showToast('没有可上传的文件', 'error');
      return;
    }

    const totalSize = validFiles.reduce((sum, f) => sum + f.size, 0);
    let uploadedBytes = 0;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      const shortName = file.name.length > 20 ? file.name.slice(0, 17) + '...' : file.name;

      try {
        const formData = new FormData();
        formData.append('image', file);

        const uploadRes = await uploadWithProgress(`${API_BASE}/api/album/upload`, formData, {
          onProgress: (prog) => {
            const prevFileBytes = validFiles.slice(0, i).reduce((s, f) => s + f.size, 0);
            const overallLoaded = prevFileBytes + prog.loaded;
            const overallPercent = Math.round((overallLoaded / totalSize) * 100);
            progressBar.style.width = `${Math.min(overallPercent, 98)}%`;
            progressText.textContent = `[${i + 1}/${validFiles.length}] ${shortName} ${prog.percent}% (${formatSpeed(prog.speed)})`;
          }
        });

        if (!uploadRes.ok) {
          const data = await uploadRes.json().catch(() => ({}));
          showToast(data.error || `${file.name} 上传失败`, 'error');
          failCount++;
          uploadedBytes += file.size;
        } else {
          successCount++;
          uploadedBytes += file.size;
        }
      } catch (err) {
        showToast(`${file.name} 上传失败: ${err.message}`, 'error');
        failCount++;
        uploadedBytes += file.size;
      }

      progressBar.style.width = `${Math.round((uploadedBytes / totalSize) * 100)}%`;
    }

    progressBar.style.width = '100%';
    progressText.textContent = '上传完成！';

    setTimeout(() => {
      progressContainer.style.display = 'none';
    }, 800);

    if (successCount > 0) {
      showToast(`成功上传 ${successCount} 个文件 💕`, 'success');
      loadAlbumPhotos();
    }

    if (failCount > 0 && successCount === 0) {
      showToast('上传失败，请重试', 'error');
    }
  }

  /**
   * 打开相册照片删除确认弹窗
   * 
   * 在弹窗中预览即将删除的照片缩略图，
   * 让用户在确认删除前能看到要删除的内容。
   * 
   * @param {number} id - 要删除的照片ID
   * @returns {void}
   */
  function handleAlbumDelete(id) {
    deletingAlbumPhotoId = id;
    const card = document.querySelector(`.album-photo-card[data-id="${id}"]`);
    const previewEl = $('#albumDeletePreview');
    if (card) {
      const img = card.querySelector('img');
      if (img) {
        const previewImg = document.createElement('img');
        previewImg.src = img.src;
        previewImg.alt = '预览';
        previewEl.innerHTML = '';
        previewEl.appendChild(previewImg);
      }
    } else {
      previewEl.innerHTML = '';
    }
    $('#albumDeleteModal').style.display = 'flex';
  }

  /**
   * 关闭相册照片删除确认弹窗
   * 
   * @returns {void}
   */
  function closeAlbumDeleteModal() {
    $('#albumDeleteModal').style.display = 'none';
    deletingAlbumPhotoId = null;
  }

  /**
   * 确认并执行相册照片删除操作
   * 
   * DELETE请求删除服务端照片记录及关联文件，
   * 成功后刷新相册列表并显示成功提示。
   * 
   * @async
   * @returns {Promise<void>}
   */
  async function confirmAlbumDelete() {
    if (!deletingAlbumPhotoId) return;

    try {
      const res = await safeFetch(`${API_BASE}/api/album/${deletingAlbumPhotoId}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || '删除失败', 'error');
        return;
      }

      showToast('照片已删除', 'success');
      closeAlbumDeleteModal();
      loadAlbumPhotos();
    } catch (err) {
      showToast('删除失败', 'error');
    }
  }

  // ==================== 应用启动 ====================
  
  document.addEventListener('DOMContentLoaded', init);
})();
