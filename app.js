/* ==========================================
   FocusGuard - Application JavaScript
   ========================================== */

// --- アプリケーションの状態管理 ---
const AppState = {
    // トラッカー関連
    tracker: {
        active: false,
        paused: false,
        timerId: null,
        activity: '',
        limitSeconds: 0,
        elapsedSeconds: 0,
        isOvertime: false,
        lastOvertimerNotificationTime: 0
    },
    // スケジュール一覧
    schedules: [],
    // 今日の統計
    stats: {
        totalUsageSeconds: 0,
        alertCount: 0,
        schedulesChecked: 0,
        schedulesMet: 0,
        activityUsage: {} // 例: { game_genshin: 120, sns_twitter: 45 }
    },
    // イベントログ
    logs: [],
    // 音響関連
    audioContext: null,
    alertSoundIntervalId: null
};

// --- 定数定義 ---
const STORAGE_KEYS = {
    SCHEDULES: 'focusguard_schedules',
    STATS: 'focusguard_stats',
    LOGS: 'focusguard_logs'
};

const ACTIVITY_LABELS = {
    game_genshin: '🎮 原神/RPGゲーム',
    game_casual: '🧩 カジュアルゲーム',
    sns_twitter: '🐦 X / Twitter',
    sns_instagram: '📸 Instagram',
    sns_youtube: '📺 YouTube/TikTok',
    sns_other: '💬 その他SNS/ネット'
};

const ACTIVITY_COLORS = {
    game_genshin: '#ff0055', // ピンク
    game_casual: '#ffaa00',  // イエロー
    sns_twitter: '#00f0ff',  // シアン
    sns_instagram: '#e1306c', // インスタ風マゼンタ
    sns_youtube: '#ff0000',  // YouTube赤
    sns_other: '#8c9ba5'     // グレー
};

// --- DOM 要素の取得 ---
document.addEventListener('DOMContentLoaded', () => {
    // 初期化
    initApp();
});

function initApp() {
    // データの読み込み
    loadData();
    
    // イベントリスナーの登録
    setupEventListeners();
    
    // 定期監視ループの開始 (1秒ごと)
    setInterval(backgroundMonitorLoop, 1000);
    
    // UIの初期更新
    updateNotificationButtonUI();
    renderSchedules();
    updateStatsUI();
    renderStatsCharts();
    renderLogs();
    
    addLog('system', 'FocusGuard が正常に起動しました 🛡️');
}

// --- ローカルストレージ連携 ---
function loadData() {
    try {
        const storedSchedules = localStorage.getItem(STORAGE_KEYS.SCHEDULES);
        if (storedSchedules) {
            AppState.schedules = JSON.parse(storedSchedules);
        }
        
        const storedStats = localStorage.getItem(STORAGE_KEYS.STATS);
        if (storedStats) {
            AppState.stats = JSON.parse(storedStats);
        } else {
            resetStats();
        }
        
        const storedLogs = localStorage.getItem(STORAGE_KEYS.LOGS);
        if (storedLogs) {
            AppState.logs = JSON.parse(storedLogs);
        }
    } catch (e) {
        console.error('データの読み込み中にエラーが発生しました', e);
        resetStats();
    }
}

function saveData() {
    try {
        localStorage.setItem(STORAGE_KEYS.SCHEDULES, JSON.stringify(AppState.schedules));
        localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(AppState.stats));
        localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(AppState.logs));
    } catch (e) {
        console.error('データの保存中にエラーが発生しました', e);
    }
}

function resetStats() {
    AppState.stats = {
        totalUsageSeconds: 0,
        alertCount: 0,
        schedulesChecked: 0,
        schedulesMet: 0,
        activityUsage: {}
    };
    saveData();
}

// --- イベントログ管理 ---
function addLog(type, message) {
    const timestamp = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    AppState.logs.unshift({ type, message, time: timestamp });
    
    // ログの上限を50件にする
    if (AppState.logs.length > 50) {
        AppState.logs.pop();
    }
    
    saveData();
    renderLogs();
}

function renderLogs() {
    const logList = document.getElementById('log-list');
    if (!logList) return;
    
    if (AppState.logs.length === 0) {
        logList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-list"></i>
                <p>イベントログはありません。</p>
            </div>
        `;
        return;
    }
    
    logList.innerHTML = AppState.logs.map(log => {
        let icon = '<i class="fa-solid fa-info-circle text-blue"></i>';
        if (log.type === 'alert') icon = '<i class="fa-solid fa-triangle-exclamation text-danger" style="color:var(--neon-pink)"></i>';
        if (log.type === 'schedule') icon = '<i class="fa-solid fa-calendar-check text-yellow" style="color:var(--neon-yellow)"></i>';
        if (log.type === 'success') icon = '<i class="fa-solid fa-circle-check text-success" style="color:var(--neon-green)"></i>';
        
        return `
            <div class="log-item">
                <span class="log-message">${icon} ${escapeHtml(log.message)}</span>
                <span class="log-time">${log.time}</span>
            </div>
        `;
    }).join('');
}

// --- イベントリスナーのセットアップ ---
function setupEventListeners() {
    // 1. SPAタブ切り替え
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetId = item.getAttribute('data-target');
            
            // ナビボタンのアクティブクラス切り替え
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            // コンテンツセクションの切り替え
            const sections = document.querySelectorAll('.tab-content');
            sections.forEach(section => {
                section.classList.remove('active');
                if (section.id === targetId) {
                    section.classList.add('active');
                }
            });
            
            // 統計画面を開いたときは再描画してアニメーションをトリガーする
            if (targetId === 'section-stats') {
                renderStatsCharts();
            }
        });
    });

    // 2. 通知有効化ボタン
    const btnNotificationSetup = document.getElementById('btn-notification-setup');
    btnNotificationSetup.addEventListener('click', requestNotificationPermission);

    // 3. トラッカー：制限時間プリセットボタン
    const presetButtons = document.querySelectorAll('.btn-preset');
    const inputLimitTime = document.getElementById('input-limit-time');
    
    presetButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            presetButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const value = btn.getAttribute('data-value');
            inputLimitTime.value = value;
            
            if (!AppState.tracker.active) {
                updateTimerDisplay(parseInt(value) * 60, parseInt(value) * 60);
            }
        });
    });

    inputLimitTime.addEventListener('input', () => {
        // プリセットのアクティブを外す
        presetButtons.forEach(b => b.classList.remove('active'));
        
        const val = parseInt(inputLimitTime.value) || 15;
        if (!AppState.tracker.active) {
            updateTimerDisplay(val * 60, val * 60);
        }
    });

    // 4. トラッカー：監視開始/停止/リセット
    const btnStart = document.getElementById('btn-start-tracker');
    const btnStop = document.getElementById('btn-stop-tracker');
    const btnReset = document.getElementById('btn-reset-tracker');
    
    btnStart.addEventListener('click', startTracker);
    btnStop.addEventListener('click', togglePauseTracker);
    btnReset.addEventListener('click', resetTracker);

    // 5. スケジュール：予定の追加
    const formAddSchedule = document.getElementById('form-add-schedule');
    formAddSchedule.addEventListener('submit', handleAddSchedule);

    // 6. スケジュール：フィルター切り替え
    const filterButtons = document.querySelectorAll('.btn-filter');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderSchedules(btn.getAttribute('data-filter'));
        });
    });

    // 7. モーダル操作
    const btnModalClose = document.getElementById('btn-modal-close');
    const btnModalSnooze = document.getElementById('btn-modal-snooze');
    
    btnModalClose.addEventListener('click', closeModal);
    btnModalSnooze.addEventListener('click', snoozeTrackerAlert);
}

// --- Web Notification API (通知) ---
function requestNotificationPermission() {
    if (!('Notification' in window)) {
        alert('このブラウザはプッシュ通知に対応していません。');
        return;
    }
    
    Notification.requestPermission().then(permission => {
        updateNotificationButtonUI();
        if (permission === 'granted') {
            sendNotification('FocusGuard 🛡️', {
                body: '通知機能が有効化されました。やりすぎ防止の警告が届きます。',
                icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png'
            });
            addLog('success', '通知機能を有効化しました。');
            initAudioContext(); // ついでにオーディオの初期化も促す
        } else {
            addLog('system', '通知の許可が拒否されました。');
        }
    });
}

function updateNotificationButtonUI() {
    const btn = document.getElementById('btn-notification-setup');
    if (!btn) return;
    
    if (!('Notification' in window)) {
        btn.innerHTML = '<i class="fa-solid fa-bell-slash"></i> 通知非対応';
        btn.disabled = true;
        btn.className = 'btn btn-secondary';
        return;
    }
    
    if (Notification.permission === 'granted') {
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> 通知有効';
        btn.className = 'btn btn-outline';
        btn.style.borderColor = 'var(--neon-green)';
        btn.style.color = 'var(--neon-green)';
    } else if (Notification.permission === 'denied') {
        btn.innerHTML = '<i class="fa-solid fa-bell-slash"></i> 通知がブロック済';
        btn.className = 'btn btn-danger';
    } else {
        btn.innerHTML = '<i class="fa-solid fa-bell"></i> 通知を有効化';
        btn.className = 'btn btn-neon-alert';
    }
}

function sendNotification(title, options) {
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            new Notification(title, options);
        } catch (e) {
            console.error('通知の送信に失敗しました', e);
        }
    }
}

// --- Web Audio API (音響警告ジェネレータ) ---
function initAudioContext() {
    if (!AppState.audioContext) {
        AppState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (AppState.audioContext.state === 'suspended') {
        AppState.audioContext.resume();
    }
}

// 動的にピピッ、というサウンドを生成
function playBeepSound(frequency = 800, duration = 0.1, type = 'sine') {
    try {
        initAudioContext();
        const ctx = AppState.audioContext;
        if (!ctx) return;
        
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        osc.type = type;
        osc.frequency.setValueAtTime(frequency, ctx.currentTime);
        
        gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
        
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        
        osc.start();
        osc.stop(ctx.currentTime + duration);
    } catch (e) {
        console.warn('オーディオ再生エラー', e);
    }
}

// サイレン警告音 (ウーウー)
function startAlertSiren() {
    if (AppState.alertSoundIntervalId) return; // 既に鳴っている場合はスキップ
    
    initAudioContext();
    const ctx = AppState.audioContext;
    if (!ctx) return;
    
    let isHigh = false;
    
    function triggerSirenBeep() {
        const freq = isHigh ? 880 : 660; // 交互に周波数を変える
        playBeepSound(freq, 0.4, 'sawtooth');
        isHigh = !isHigh;
    }
    
    triggerSirenBeep();
    AppState.alertSoundIntervalId = setInterval(triggerSirenBeep, 500);
}

function stopAlertSiren() {
    if (AppState.alertSoundIntervalId) {
        clearInterval(AppState.alertSoundIntervalId);
        AppState.alertSoundIntervalId = null;
    }
}

// --- トラッカー（時間監視）ロジック ---
function startTracker() {
    initAudioContext(); // ユーザーのアクションに紐づけてオーディオ初期化
    
    const selectActivity = document.getElementById('select-activity');
    const inputLimitTime = document.getElementById('input-limit-time');
    
    const activity = selectActivity.value;
    const limitMinutes = parseInt(inputLimitTime.value) || 15;
    
    AppState.tracker.activity = activity;
    AppState.tracker.limitSeconds = limitMinutes * 60;
    AppState.tracker.elapsedSeconds = 0;
    AppState.tracker.active = true;
    AppState.tracker.paused = false;
    AppState.tracker.isOvertime = false;
    
    // UIの制御
    document.getElementById('btn-start-tracker').classList.add('hidden');
    document.getElementById('btn-stop-tracker').classList.remove('hidden');
    document.getElementById('btn-reset-tracker').classList.remove('hidden');
    document.getElementById('select-activity').disabled = true;
    document.getElementById('input-limit-time').disabled = true;
    document.querySelectorAll('.btn-preset').forEach(b => b.disabled = true);
    
    const statusBadge = document.getElementById('tracker-status-badge');
    statusBadge.classList.remove('hidden');
    statusBadge.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${ACTIVITY_LABELS[activity]} 監視中`;
    
    // タイマーループの開始
    if (AppState.tracker.timerId) clearInterval(AppState.tracker.timerId);
    AppState.tracker.timerId = setInterval(updateTrackerTick, 1000);
    
    // 進捗表示の初期化
    const totalSeconds = AppState.tracker.limitSeconds;
    updateTimerDisplay(totalSeconds, totalSeconds);
    
    // ログと開始通知
    addLog('system', `${ACTIVITY_LABELS[activity]} の監視を開始しました。（目標：${limitMinutes}分）`);
    sendNotification('FocusGuard 監視開始', {
        body: `${ACTIVITY_LABELS[activity]} の利用を開始します。制限時間は ${limitMinutes} 分です。`,
        tag: 'tracker-system'
    });
    
    // 効果音
    playBeepSound(600, 0.15, 'sine');
    setTimeout(() => playBeepSound(900, 0.2, 'sine'), 100);
}

function togglePauseTracker() {
    if (!AppState.tracker.active) return;
    
    const btnStop = document.getElementById('btn-stop-tracker');
    
    if (AppState.tracker.paused) {
        // 再開
        AppState.tracker.paused = false;
        btnStop.innerHTML = '<i class="fa-solid fa-pause"></i> 一時停止';
        btnStop.className = 'btn btn-secondary btn-block';
        addLog('system', '監視を再開しました。');
        playBeepSound(800, 0.1, 'sine');
    } else {
        // 一時停止
        AppState.tracker.paused = true;
        btnStop.innerHTML = '<i class="fa-solid fa-play"></i> 再開';
        btnStop.className = 'btn btn-primary btn-block';
        addLog('system', '監視を一時停止しました。');
        playBeepSound(500, 0.1, 'sine');
    }
}

function resetTracker() {
    if (!AppState.tracker.active) return;
    
    // 確認ダイアログ (過剰利用警告中にリセットする場合は特になし)
    const label = ACTIVITY_LABELS[AppState.tracker.activity];
    const minsUsed = Math.floor(AppState.tracker.elapsedSeconds / 60);
    const secsUsed = AppState.tracker.elapsedSeconds % 60;
    
    // 統計データに加算
    AppState.stats.totalUsageSeconds += AppState.tracker.elapsedSeconds;
    
    const act = AppState.tracker.activity;
    AppState.stats.activityUsage[act] = (AppState.stats.activityUsage[act] || 0) + AppState.tracker.elapsedSeconds;
    
    addLog('success', `${label} の利用を終了しました。（使用時間: ${minsUsed}分${secsUsed}秒）`);
    
    // スレッド停止
    if (AppState.tracker.timerId) {
        clearInterval(AppState.tracker.timerId);
        AppState.tracker.timerId = null;
    }
    
    stopAlertSiren();
    
    // 状態クリア
    AppState.tracker.active = false;
    AppState.tracker.paused = false;
    AppState.tracker.isOvertime = false;
    
    // UI復元
    document.getElementById('btn-start-tracker').classList.remove('hidden');
    document.getElementById('btn-stop-tracker').classList.add('hidden');
    document.getElementById('btn-reset-tracker').classList.add('hidden');
    document.getElementById('select-activity').disabled = false;
    document.getElementById('input-limit-time').disabled = false;
    document.querySelectorAll('.btn-preset').forEach(b => b.disabled = false);
    
    document.getElementById('tracker-status-badge').classList.add('hidden');
    
    const displayCard = document.querySelector('.tracker-display');
    displayCard.className = 'card glass tracker-display';
    
    document.getElementById('timer-label').textContent = 'STANDBY';
    const limitMinutes = parseInt(document.getElementById('input-limit-time').value) || 15;
    updateTimerDisplay(limitMinutes * 60, limitMinutes * 60);
    
    // モーダルや警告の削除
    document.body.classList.remove('fullscreen-warning-flash');
    
    // 統計・ダッシュボードの更新
    saveData();
    updateStatsUI();
    renderStatsCharts();
    
    playBeepSound(400, 0.3, 'sine');
}

function updateTrackerTick() {
    if (!AppState.tracker.active || AppState.tracker.paused) return;
    
    AppState.tracker.elapsedSeconds++;
    
    const total = AppState.tracker.limitSeconds;
    const elapsed = AppState.tracker.elapsedSeconds;
    const remaining = Math.max(0, total - elapsed);
    
    updateTimerDisplay(remaining, total);
    
    // 段階的警告の制御
    const displayCard = document.querySelector('.tracker-display');
    const timerLabel = document.getElementById('timer-label');
    
    if (elapsed >= total) {
        // ------------------ 【時間超過！ DANGER状態】 ------------------
        if (!AppState.tracker.isOvertime) {
            AppState.tracker.isOvertime = true;
            AppState.stats.alertCount++;
            saveData();
            updateStatsUI();
            
            addLog('alert', `【警告】 ${ACTIVITY_LABELS[AppState.tracker.activity]} の制限時間を超過しました！`);
            
            // 強力警告の発動
            triggerOvertimeWarning();
        } else {
            // オーバータイム中は1分おきに「しつこい通知」を送る
            const now = Date.now();
            if (now - AppState.tracker.lastOvertimerNotificationTime > 60000) {
                AppState.tracker.lastOvertimerNotificationTime = now;
                sendNotification('⚠️ 今すぐやめてください！', {
                    body: `制限時間をすでに ${Math.floor(elapsed / 60)} 分超過しています！体を動かし、休憩をとりましょう。`,
                    requireInteraction: true,
                    tag: 'overtime-nag'
                });
                playBeepSound(900, 0.3, 'sawtooth');
            }
        }
        
        displayCard.className = 'card glass tracker-display state-danger';
        timerLabel.textContent = 'OVERTIME';
        
    } else if (remaining <= total * 0.1) {
        // ------------------ 【残り10%以下！ WARNING状態】 ------------------
        displayCard.className = 'card glass tracker-display state-warning';
        timerLabel.textContent = 'NEAR LIMIT';
        
        // 10%到達時のピピピッというマイルド警告
        if (remaining === Math.floor(total * 0.1)) {
            sendNotification('⌛ 残り時間わずかです！', {
                body: `${ACTIVITY_LABELS[AppState.tracker.activity]} の制限時間があと 10%（約 ${Math.ceil(remaining / 60)}分）です。`,
                tag: 'tracker-warning'
            });
            playBeepSound(700, 0.15, 'sine');
            setTimeout(() => playBeepSound(700, 0.15, 'sine'), 200);
            addLog('system', '目標時間の90%を経過しました。');
        }
    } else {
        // ------------------ 【通常状態】 ------------------
        displayCard.className = 'card glass tracker-display';
        timerLabel.textContent = 'MONITORING';
    }
}

// タイマー描画を更新
function updateTimerDisplay(remainingSeconds, totalSeconds) {
    const isOver = AppState.tracker.isOvertime;
    let secondsToDisplay = remainingSeconds;
    
    if (isOver) {
        // 超過時間をカウントアップ表示にする
        secondsToDisplay = AppState.tracker.elapsedSeconds - totalSeconds;
    }
    
    const minutes = Math.floor(secondsToDisplay / 60);
    const seconds = secondsToDisplay % 60;
    
    const timeString = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    document.getElementById('timer-time').textContent = timeString;
    
    // 円形プログレスバーの更新
    const circle = document.getElementById('timer-progress');
    const radius = 85;
    const circumference = 2 * Math.PI * radius; // 約 534
    
    let offset;
    let percentageText;
    
    if (isOver) {
        // 超過状態：プログレスバーを満タン（赤）にした上でパーセントを増加
        offset = 0;
        const overPercent = Math.floor((AppState.tracker.elapsedSeconds / totalSeconds) * 100);
        percentageText = `超過 ${overPercent - 100}%`;
    } else {
        // 通常状態：残りに応じて減らしていく
        const ratio = remainingSeconds / totalSeconds;
        offset = circumference * (1 - ratio);
        const percent = Math.floor(ratio * 100);
        percentageText = `${100 - percent}%`;
    }
    
    circle.style.strokeDashoffset = offset;
    document.getElementById('timer-percentage').textContent = percentageText;
}

// 制限時間超過時の強力アクション
function triggerOvertimeWarning() {
    // 1. 全画面の赤色点滅クラス追加
    document.body.classList.add('fullscreen-warning-flash');
    
    // 2. ブラウザ通知
    sendNotification('🚨 やりすぎ警告！', {
        body: `${ACTIVITY_LABELS[AppState.tracker.activity]} の制限時間（${Math.floor(AppState.tracker.limitSeconds / 60)}分）を超過しました！今すぐ終了してください。`,
        icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
        requireInteraction: true,
        tag: 'tracker-overtime'
    });
    
    // 3. サイレン音の開始
    startAlertSiren();
    
    // 4. モーダルのポップアップ
    showModal({
        title: '⚠️ アプリ過剰利用警告！',
        message: `${ACTIVITY_LABELS[AppState.tracker.activity]} をやりすぎています！設定された目標制限時間を超過しました。画面を見つめ続けるのをやめ、目を休めましょう。`,
        isScheduleAlert: false,
        allowSnooze: true
    });
}

// --- スケジュール管理ロジック ---
function handleAddSchedule(e) {
    e.preventDefault();
    
    const titleInput = document.getElementById('schedule-title');
    const timeInput = document.getElementById('schedule-time');
    const prioritySelect = document.getElementById('schedule-priority');
    const reminderSelect = document.getElementById('schedule-reminder');
    
    const title = titleInput.value.trim();
    const targetTime = timeInput.value; // YYYY-MM-DDTHH:mm
    const priority = prioritySelect.value;
    const reminderMinutes = parseInt(reminderSelect.value);
    
    if (!title || !targetTime) return;
    
    const newSchedule = {
        id: 'sched_' + Date.now(),
        title: title,
        time: targetTime,
        priority: priority,
        reminderMinutes: reminderMinutes,
        notifiedBefore: false,   // 事前通知したか
        notifiedExact: false,    // ジャスト通知したか
        interruptedAlert: false  // やりすぎ割り込み警告を発動したか
    };
    
    AppState.schedules.push(newSchedule);
    
    // スケジュール順にソート (時間昇順)
    AppState.schedules.sort((a, b) => new Date(a.time) - new Date(b.time));
    
    saveData();
    renderSchedules();
    
    // フォームリセット
    titleInput.value = '';
    timeInput.value = '';
    prioritySelect.value = 'medium';
    reminderSelect.value = '5';
    
    addLog('schedule', `予定「${title}」を登録しました。（予定時刻：${formatDateTime(targetTime)}）`);
    playBeepSound(900, 0.15, 'sine');
}

function renderSchedules(filter = 'all') {
    const listContainer = document.getElementById('schedule-list');
    if (!listContainer) return;
    
    const now = new Date();
    
    // フィルターの適用
    let filtered = AppState.schedules;
    if (filter === 'upcoming') {
        filtered = AppState.schedules.filter(s => new Date(s.time) >= now);
    } else if (filter === 'past') {
        filtered = AppState.schedules.filter(s => new Date(s.time) < now);
    }
    
    if (filtered.length === 0) {
        let msg = '予定が登録されていません。左のフォームから追加してください。';
        if (filter === 'upcoming') msg = '今後の予定はありません。';
        if (filter === 'past') msg = '終了した過去の予定はありません。';
        
        listContainer.innerHTML = `
            <div class="empty-state">
                <i class="fa-regular fa-calendar-plus"></i>
                <p>${msg}</p>
            </div>
        `;
        return;
    }
    
    listContainer.innerHTML = filtered.map(item => {
        const itemTime = new Date(item.time);
        const isPast = itemTime < now;
        const formattedTime = formatDateTime(item.time);
        
        let priorityLabel = '🟢 低';
        if (item.priority === 'high') priorityLabel = '🔴 高';
        if (item.priority === 'medium') priorityLabel = '🟡 中';
        
        let reminderLabel = '直前のみ';
        if (item.reminderMinutes > 0) reminderLabel = `${item.reminderMinutes}分前`;
        
        return `
            <div class="schedule-item priority-${item.priority} ${isPast ? 'past' : ''}" id="item-${item.id}">
                <div class="schedule-info">
                    <div class="schedule-title-text">${escapeHtml(item.title)}</div>
                    <div class="schedule-meta-text">
                        <span><i class="fa-regular fa-clock"></i> ${formattedTime}</span>
                        <span><i class="fa-solid fa-flag"></i> 優先度: ${priorityLabel}</span>
                        <span><i class="fa-solid fa-bell"></i> ${reminderLabel}通知</span>
                    </div>
                </div>
                <div class="schedule-actions">
                    <button class="btn-delete-schedule" onclick="deleteSchedule('${item.id}')" title="削除">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function deleteSchedule(id) {
    const idx = AppState.schedules.findIndex(s => s.id === id);
    if (idx !== -1) {
        const sched = AppState.schedules[idx];
        
        // グローバルルール「ファイルを消す際は必ず許可を取ること」がありますが、
        // アプリ内データの削除はファイル削除ではないためそのまま実行します。
        AppState.schedules.splice(idx, 1);
        saveData();
        renderSchedules(document.querySelector('.btn-filter.active').getAttribute('data-filter') || 'all');
        addLog('system', `予定「${sched.title}」を削除しました。`);
        playBeepSound(400, 0.1, 'sine');
    }
}

// --- 常時監視・バックグラウンド連携ループ (1秒に1回動作) ---
function backgroundMonitorLoop() {
    const now = new Date();
    
    // スケジュール配列をチェック
    AppState.schedules.forEach(schedule => {
        const schedTime = new Date(schedule.time);
        const timeDiffMs = schedTime.getTime() - now.getTime();
        const timeDiffMins = timeDiffMs / 60000;
        
        // ------------------ 【1. 事前リマインダー通知】 ------------------
        if (schedule.reminderMinutes > 0 && !schedule.notifiedBefore) {
            // 設定された「〇分前」の条件を満たすかチェック (例: 5分前であれば、現在残り5分〜4.9分)
            if (timeDiffMins > 0 && timeDiffMins <= schedule.reminderMinutes) {
                schedule.notifiedBefore = true;
                saveData();
                
                // リマインダーの発信
                triggerScheduleNotification(schedule, `予定の ${schedule.reminderMinutes} 分前です！`, false);
            }
        }
        
        // ------------------ 【2. 予定時刻ジャスト通知】 ------------------
        if (!schedule.notifiedExact) {
            // 予定時刻を過ぎた（かつ過ぎてから1分以内）のタイミング
            if (timeDiffMs <= 0 && timeDiffMs > -60000) {
                schedule.notifiedExact = true;
                AppState.stats.schedulesChecked++;
                
                // もしトラッカーが動いていなかった＝自己規制してスマホを置いて予定通り行動できたとみなす！
                if (!AppState.tracker.active) {
                    AppState.stats.schedulesMet++;
                    addLog('success', `🎉 予定「${schedule.title}」の時刻になりました。スマホ利用を自制できています！`);
                }
                
                saveData();
                updateStatsUI();
                
                // 直前リマインダーの発信
                triggerScheduleNotification(schedule, `予定時刻になりました！`, true);
            }
        }
    });
}

// スケジュール通知とやりすぎ時（タイマー稼働中）の超強力割り込み警告
function triggerScheduleNotification(schedule, headerText, isExact) {
    const isAppRunning = AppState.tracker.active && !AppState.tracker.paused;
    const formattedTime = formatTimeOnly(schedule.time);
    
    if (isAppRunning) {
        // ==========================================================================
        // 【超強力割り込み！】スマホでゲーム・SNSやりすぎ中 ＋ スケジュール到達！
        // ==========================================================================
        
        // 1. ログ記録
        addLog('alert', `【超強力警告】 ${ACTIVITY_LABELS[AppState.tracker.activity]} をやりすぎ中に、予定「${schedule.title}」の時間が迫っています！`);
        
        // 2. プッシュ通知 (極めて緊急度の高いメッセージ)
        sendNotification(`🚨 超緊急警告：予定が始まります！`, {
            body: `今すぐ ${ACTIVITY_LABELS[AppState.tracker.activity]} をやめてください！\n【予定】「${schedule.title}」(${formattedTime}〜)\n予定の準備を今すぐ開始しましょう！`,
            icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
            requireInteraction: true,
            tag: 'critical-schedule-alert'
        });
        
        // 3. 全画面を警告モード（赤点滅）にし、大音量アラート開始
        document.body.classList.add('fullscreen-warning-flash');
        startAlertSiren();
        
        // 4. 強力なモーダルを展開
        showModal({
            title: `⚠️ 予定への遅刻警告！`,
            message: `現在「${ACTIVITY_LABELS[AppState.tracker.activity]}」を使用中ですが、大切な予定が迫っています。今すぐスマホを置き、予定の準備に取り掛かりましょう！`,
            isScheduleAlert: true,
            scheduleName: schedule.title,
            scheduleTime: `${formattedTime} (${isExact ? '今すぐ' : 'まもなく開始'})`,
            allowSnooze: !isExact // 予定時刻ジャストの場合はスヌーズ不可（厳しくする）
        });
        
    } else {
        // ==========================================================================
        // 【通常リマインダー】スマホやりすぎ中ではない場合 (平和な通常通知)
        // ==========================================================================
        addLog('schedule', `【リマインダー】予定「${schedule.title}」: ${headerText}`);
        
        let soundFreq = 500;
        if (schedule.priority === 'high') soundFreq = 900;
        
        // 優しいチャイム音
        playBeepSound(soundFreq, 0.15, 'sine');
        setTimeout(() => playBeepSound(soundFreq * 1.25, 0.25, 'sine'), 150);
        
        sendNotification(`🛡️ FocusGuard スケジュールリマインド`, {
            body: `${headerText}\n【${schedule.title}】(${formattedTime}〜)\n優先度: ${schedule.priority.toUpperCase()}`,
            tag: schedule.id
        });
    }
}

// --- モーダル制御（警告ウィンドウ） ---
function showModal(options) {
    const modal = document.getElementById('alert-modal');
    const title = document.getElementById('modal-alert-title');
    const message = document.getElementById('modal-alert-message');
    const scheduleBox = document.getElementById('modal-schedule-info');
    const btnSnooze = document.getElementById('btn-modal-snooze');
    
    title.textContent = options.title;
    message.textContent = options.message;
    
    // スケジュール連携か
    if (options.isScheduleAlert) {
        scheduleBox.classList.remove('hidden');
        document.getElementById('modal-schedule-name').textContent = options.scheduleName;
        document.getElementById('modal-schedule-time').textContent = options.scheduleTime;
    } else {
        scheduleBox.classList.add('hidden');
    }
    
    // スヌーズを許可するか
    if (options.allowSnooze) {
        btnSnooze.classList.remove('hidden');
    } else {
        btnSnooze.classList.add('hidden');
    }
    
    modal.classList.remove('hidden');
}

function closeModal() {
    document.getElementById('alert-modal').classList.add('hidden');
    document.body.classList.remove('fullscreen-warning-flash');
    stopAlertSiren();
    
    // トラッカーをリセット（やりすぎ警告の閉じるボタン ＝ ゲーム終了の意思表示とする）
    if (AppState.tracker.active) {
        resetTracker();
    }
}

function snoozeTrackerAlert() {
    // 1分だけ延長するスヌーズロジック
    document.getElementById('alert-modal').classList.add('hidden');
    document.body.classList.remove('fullscreen-warning-flash');
    stopAlertSiren();
    
    if (AppState.tracker.active) {
        AppState.tracker.limitSeconds += 60; // 制限時間を60秒（1分）増やす
        AppState.tracker.isOvertime = false;
        
        addLog('system', 'タイマーを 1分間 延長（スヌーズ）しました。');
        playBeepSound(600, 0.2, 'sine');
    }
}

// --- 統計ダッシュボード描画 ---
function updateStatsUI() {
    // 総使用時間
    const totalSec = AppState.stats.totalUsageSeconds;
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    
    document.getElementById('total-time-hours').textContent = String(hours).padStart(2, '0');
    document.getElementById('total-time-minutes').textContent = String(minutes).padStart(2, '0');
    document.getElementById('total-time-seconds').textContent = String(seconds).padStart(2, '0');
    
    // 警告回数
    document.getElementById('stat-alert-count').innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> 警告発生: ${AppState.stats.alertCount}回`;
    
    // 予定遵守率
    let ratio = 0;
    if (AppState.stats.schedulesChecked > 0) {
        ratio = Math.round((AppState.stats.schedulesMet / AppState.stats.schedulesChecked) * 100);
    }
    document.getElementById('stat-success-count').innerHTML = `<i class="fa-solid fa-square-check"></i> 予定遵守率: ${ratio}%`;
}

function renderStatsCharts() {
    const listContainer = document.getElementById('activity-breakdown-list');
    if (!listContainer) return;
    
    const usage = AppState.stats.activityUsage;
    const activities = Object.keys(usage);
    
    if (activities.length === 0) {
        listContainer.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-chart-line"></i>
                <p>本日の利用データはありません。</p>
            </div>
        `;
        return;
    }
    
    // 総計を算出
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    
    listContainer.innerHTML = activities.map(act => {
        const seconds = usage[act];
        const percent = total > 0 ? Math.round((seconds / total) * 100) : 0;
        
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        const color = ACTIVITY_COLORS[act] || '#fff';
        const label = ACTIVITY_LABELS[act] || act;
        const iconClass = document.querySelector(`#select-activity option[value="${act}"]`)?.getAttribute('data-icon') || 'fa-solid fa-hashtag';
        
        return `
            <div class="breakdown-item">
                <div class="breakdown-header">
                    <span class="breakdown-label"><i class="${iconClass}" style="color:${color}"></i> ${label}</span>
                    <span class="breakdown-value">${m}分${s}秒 (${percent}%)</span>
                </div>
                <div class="breakdown-bar-container">
                    <div class="breakdown-bar" style="width: ${percent}%; background-color: ${color}"></div>
                </div>
            </div>
        `;
    }).join('');
}

// --- ユーティリティ関数 ---
function formatDateTime(dateTimeString) {
    const date = new Date(dateTimeString);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hr = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${d} ${hr}:${min}`;
}

function formatTimeOnly(dateTimeString) {
    const date = new Date(dateTimeString);
    const hr = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${hr}:${min}`;
}

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>'"]/g, tag => {
        const chars = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        };
        return chars[tag] || tag;
    });
}
