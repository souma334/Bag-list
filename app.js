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
        lastOvertimerNotificationTime: 0,
        // --- バックグラウンド対応: 実時刻（タイムスタンプ）ベースで経過時間を管理 ---
        startedAt: null,      // 監視開始時刻 (epoch ms)
        pausedAt: null,       // 一時停止した時刻 (epoch ms) / 停止中でなければ null
        totalPausedMs: 0,     // これまでに一時停止していた合計時間
        wakeLock: null        // Wake Lock APIのハンドル
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
    // 診断関連
    diagnosis: {
        currentQuestionIdx: 0,
        scores: [],
        history: []
    },
    // Service Worker（通知の信頼性向上用）
    swRegistration: null,
    // タブが最後にバックグラウンドに回った時刻
    lastHiddenAt: null,
    // セキュリティ・ロック関連
    security: {
        passcode: '',
        appLockEnabled: false,
        lockScreenActive: false,
        lockTimerEnabled: false,
        tempInput: '',
        setupStep: 0, // 0:設定メニュー, 1:1回目入力, 2:確認入力
        setupTempPasscode: '',
        onUnlockCallback: null
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
    LOGS: 'focusguard_logs',
    DIAG_HISTORY: 'focusguard_diag_history',
    SECURITY: 'focusguard_security',
    TRACKER: 'focusguard_tracker'
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

    // バックグラウンド対応の各種セットアップ（Service Worker / 画面表示状態の監視など）
    registerServiceWorker();
    setupBackgroundHandlers();

    // 定期監視ループの開始 (1秒ごと)
    setInterval(backgroundMonitorLoop, 1000);

    // UIの初期更新
    updateNotificationButtonUI();
    renderSchedules();
    updateStatsUI();
    renderStatsCharts();
    renderDiagHistory();
    renderLogs();

    addLog('system', 'FocusGuard が正常に起動しました 🛡️');

    // アプリ起動時のロック認証判定
    if (AppState.security.appLockEnabled && AppState.security.passcode) {
        showLockScreen(null, "アプリ起動ロック");
    }

    // 前回、監視中のままタブが閉じられていた場合は状態を復元する
    resumeTrackerIfActive();
}

// --- バックグラウンド対応: Service Worker 登録 ---
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('sw.js')
        .then(registration => {
            AppState.swRegistration = registration;
        })
        .catch(e => {
            console.warn('Service Workerの登録に失敗しました（通知は通常方式で送信されます）', e);
        });
}

// --- バックグラウンド対応: 画面の表示/非表示・終了時のハンドラ ---
function setupBackgroundHandlers() {
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // タブを閉じる/リロードする直前に、確実に現在の状態を保存する
    window.addEventListener('pagehide', () => saveData());
    window.addEventListener('beforeunload', () => saveData());
}

function handleVisibilityChange() {
    if (document.hidden) {
        // バックグラウンドに回った瞬間の状態を保存（ブラウザに強制終了されても復元できるように）
        AppState.lastHiddenAt = Date.now();
        saveTrackerState();
    } else {
        // フォアグラウンドに復帰：バックグラウンド中にtickが間引かれていた分を即座に追いつかせる
        document.title = 'FocusGuard 🛡️ | スマホやりすぎ防止＆スケジュール連携';

        if (AppState.tracker.active && !AppState.tracker.paused) {
            updateTrackerTick();
            requestWakeLock(); // Wake Lockは非表示になると自動解除されるため再取得
        }

        backgroundMonitorLoop();
    }
}

// アプリ起動時に、前回監視中だったトラッカーを復元する
function resumeTrackerIfActive() {
    if (!AppState.tracker.active) return;

    const total = AppState.tracker.limitSeconds;
    AppState.tracker.elapsedSeconds = computeElapsedSeconds();
    const wasOvertimeAlready = AppState.tracker.isOvertime;

    addLog('system', `前回のセッション（${ACTIVITY_LABELS[AppState.tracker.activity] || AppState.tracker.activity}）の監視をバックグラウンドから復元しました。`);

    // UIをトラッキング中の状態に戻す
    const btnStart = document.getElementById('btn-start-tracker');
    const btnStop = document.getElementById('btn-stop-tracker');
    const btnReset = document.getElementById('btn-reset-tracker');
    const selectActivity = document.getElementById('select-activity');
    const inputLimitTime = document.getElementById('input-limit-time');
    const checkLockTimer = document.getElementById('check-lock-timer');
    const statusBadge = document.getElementById('tracker-status-badge');

    if (btnStart) btnStart.classList.add('hidden');
    if (btnReset) btnReset.classList.remove('hidden');
    if (selectActivity) { selectActivity.value = AppState.tracker.activity; selectActivity.disabled = true; }
    if (inputLimitTime) { inputLimitTime.value = Math.round(total / 60); inputLimitTime.disabled = true; }
    document.querySelectorAll('.btn-preset').forEach(b => b.disabled = true);
    if (checkLockTimer) {
        checkLockTimer.checked = !!AppState.security.lockTimerEnabled;
        checkLockTimer.disabled = true;
    }

    if (statusBadge) {
        statusBadge.classList.remove('hidden');
        statusBadge.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${ACTIVITY_LABELS[AppState.tracker.activity]} 監視中`;
    }
    const bgIndicator = document.getElementById('tracker-bg-indicator');
    if (bgIndicator) bgIndicator.classList.remove('hidden');

    if (AppState.tracker.paused) {
        if (btnStop) {
            btnStop.classList.remove('hidden');
            btnStop.innerHTML = '<i class="fa-solid fa-play"></i> 再開';
            btnStop.className = 'btn btn-primary btn-block';
        }
    } else {
        if (btnStop) {
            btnStop.classList.remove('hidden');
            btnStop.innerHTML = '<i class="fa-solid fa-pause"></i> 一時停止';
            btnStop.className = 'btn btn-secondary btn-block';
        }
        if (AppState.tracker.timerId) clearInterval(AppState.tracker.timerId);
        AppState.tracker.timerId = setInterval(updateTrackerTick, 1000);
        requestWakeLock();
    }

    updateTimerDisplay(Math.max(0, total - AppState.tracker.elapsedSeconds), total);

    // タブが閉じられている間に制限時間を超過していた場合、復帰した瞬間に警告を出す
    if (AppState.tracker.elapsedSeconds >= total && !wasOvertimeAlready) {
        AppState.tracker.isOvertime = true;
        AppState.stats.alertCount++;
        saveData();
        updateStatsUI();
        updateAppBadge();
        addLog('alert', `【警告】バックグラウンドで監視中に ${ACTIVITY_LABELS[AppState.tracker.activity]} の制限時間を超過していました！`);
        triggerOvertimeWarning();
    } else if (AppState.tracker.isOvertime) {
        document.querySelector('.tracker-display').className = 'card glass tracker-display state-danger';
        document.getElementById('timer-label').textContent = 'OVERTIME';
        updateAppBadge();
    }

    saveTrackerState();
}

// --- バックグラウンド対応: Wake Lock（監視中は画面を消灯させない） ---
async function requestWakeLock() {
    if (!('wakeLock' in navigator) || AppState.tracker.wakeLock) return;
    try {
        AppState.tracker.wakeLock = await navigator.wakeLock.request('screen');
        AppState.tracker.wakeLock.addEventListener('release', () => {
            AppState.tracker.wakeLock = null;
        });
    } catch (e) {
        // ユーザー操作外や非対応環境では取得に失敗することがあるが、致命的ではないので握りつぶす
        console.warn('Wake Lockの取得に失敗しました', e);
    }
}

function releaseWakeLock() {
    if (AppState.tracker.wakeLock) {
        AppState.tracker.wakeLock.release().catch(() => {});
        AppState.tracker.wakeLock = null;
    }
}

// --- バックグラウンド対応: Badging API（タブを見ていなくても超過をアイコンで知らせる） ---
function updateAppBadge() {
    if (!('setAppBadge' in navigator)) return;
    try {
        if (AppState.tracker.isOvertime) {
            navigator.setAppBadge(1);
        } else {
            navigator.clearAppBadge();
        }
    } catch (e) { /* 非対応環境は無視 */ }
}

function clearAppBadge() {
    if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(() => {});
    }
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

        const storedDiagHistory = localStorage.getItem(STORAGE_KEYS.DIAG_HISTORY);
        if (storedDiagHistory) {
            AppState.diagnosis.history = JSON.parse(storedDiagHistory);
        }

        const storedSecurity = localStorage.getItem(STORAGE_KEYS.SECURITY);
        if (storedSecurity) {
            AppState.security = {...AppState.security, ...JSON.parse(storedSecurity)};
        }

        // バックグラウンド対応：前回のトラッカー状態を復元（タブを閉じても監視が継続していたことにする）
        const storedTracker = localStorage.getItem(STORAGE_KEYS.TRACKER);
        if (storedTracker) {
            const parsedTracker = JSON.parse(storedTracker);
            AppState.tracker = {...AppState.tracker, ...parsedTracker, timerId: null, wakeLock: null};
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
        localStorage.setItem(STORAGE_KEYS.DIAG_HISTORY, JSON.stringify(AppState.diagnosis.history));
        
        // 保存対象を絞る（コールバック関数等は除く）
        const securityToSave = {
            passcode: AppState.security.passcode,
            appLockEnabled: AppState.security.appLockEnabled
        };
        localStorage.setItem(STORAGE_KEYS.SECURITY, JSON.stringify(securityToSave));

        saveTrackerState();
    } catch (e) {
        console.error('データの保存中にエラーが発生しました', e);
    }
}

// トラッカーの状態だけを保存（タブが閉じられても・再起動しても続きから復元できるようにする）
function saveTrackerState() {
    try {
        const trackerToSave = {
            active: AppState.tracker.active,
            paused: AppState.tracker.paused,
            activity: AppState.tracker.activity,
            limitSeconds: AppState.tracker.limitSeconds,
            elapsedSeconds: AppState.tracker.elapsedSeconds,
            isOvertime: AppState.tracker.isOvertime,
            lastOvertimerNotificationTime: AppState.tracker.lastOvertimerNotificationTime,
            startedAt: AppState.tracker.startedAt,
            pausedAt: AppState.tracker.pausedAt,
            totalPausedMs: AppState.tracker.totalPausedMs,
            lockTimerEnabled: AppState.security.lockTimerEnabled
        };
        localStorage.setItem(STORAGE_KEYS.TRACKER, JSON.stringify(trackerToSave));
    } catch (e) {
        console.error('トラッカー状態の保存中にエラーが発生しました', e);
    }
}

function clearTrackerState() {
    localStorage.removeItem(STORAGE_KEYS.TRACKER);
}

// 実時刻ベースで経過秒数を算出する（バックグラウンドでtickが間引かれても正確な値になる）
function computeElapsedSeconds() {
    if (!AppState.tracker.active || !AppState.tracker.startedAt) return AppState.tracker.elapsedSeconds || 0;

    const now = Date.now();
    let pausedMs = AppState.tracker.totalPausedMs || 0;
    if (AppState.tracker.paused && AppState.tracker.pausedAt) {
        pausedMs += (now - AppState.tracker.pausedAt);
    }

    return Math.max(0, Math.floor((now - AppState.tracker.startedAt - pausedMs) / 1000));
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
                renderDiagHistory();
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

    // 7.5 セキュリティロック操作
    const btnLockSetup = document.getElementById('btn-lock-setup');
    if (btnLockSetup) {
        btnLockSetup.addEventListener('click', openLockSetupModal);
    }
    
    const btnCloseLockSetup = document.getElementById('btn-close-lock-setup');
    if (btnCloseLockSetup) {
        btnCloseLockSetup.addEventListener('click', () => {
            document.getElementById('lock-setup-modal').classList.add('hidden');
        });
    }

    const toggleAppLock = document.getElementById('toggle-app-lock');
    if (toggleAppLock) {
        toggleAppLock.addEventListener('change', (e) => {
            AppState.security.appLockEnabled = e.target.checked;
            saveData();
            addLog('system', `起動ロックを ${e.target.checked ? '有効' : '無効'} に設定しました。`);
        });
    }

    const btnChangePasscode = document.getElementById('btn-change-passcode');
    if (btnChangePasscode) {
        btnChangePasscode.addEventListener('click', () => {
            initPasscodeSetupFlow();
        });
    }

    const btnDisablePasscode = document.getElementById('btn-disable-passcode');
    if (btnDisablePasscode) {
        btnDisablePasscode.addEventListener('click', () => {
            if (confirm('ロック機能を完全に無効化しますか？（現在のパスコードは消去されます）')) {
                disablePasscodeLock();
            }
        });
    }

    // テンキーのイベント登録（設定用とロック画面用）
    document.querySelectorAll('#setup-numpad .num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.getAttribute('data-val');
            handleSetupNumpadInput(val);
        });
    });

    document.querySelectorAll('#screen-numpad .num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.getAttribute('data-val');
            handleScreenNumpadInput(val);
        });
    });

    // 緊急誓約解除
    const btnShowBypass = document.getElementById('btn-show-bypass');
    if (btnShowBypass) {
        btnShowBypass.addEventListener('click', () => {
            const bypassForm = document.getElementById('bypass-form');
            bypassForm.classList.toggle('hidden');
            // 入力エリアをクリア
            document.getElementById('bypass-input').value = '';
        });
    }

    const btnSubmitBypass = document.getElementById('btn-submit-bypass');
    if (btnSubmitBypass) {
        btnSubmitBypass.addEventListener('click', () => {
            handleEmergencyBypass();
        });
    }

    // 8. 診断機能操作
    const btnStartDiag = document.getElementById('btn-start-diag');
    if (btnStartDiag) {
        btnStartDiag.addEventListener('click', startDiagnosis);
    }

    const btnDiagAnswers = document.querySelectorAll('.btn-diag-ans');
    btnDiagAnswers.forEach(btn => {
        btn.addEventListener('click', () => {
            const score = parseInt(btn.getAttribute('data-score'));
            handleDiagnosisAnswer(score);
        });
    });

    const btnRestartDiag = document.getElementById('btn-restart-diag');
    if (btnRestartDiag) {
        btnRestartDiag.addEventListener('click', resetDiagnosis);
    }

    const btnAutoTracker = document.getElementById('btn-auto-tracker');
    if (btnAutoTracker) {
        btnAutoTracker.addEventListener('click', () => {
            const history = AppState.diagnosis.history;
            if (history.length === 0) return;
            
            const lastDiag = history[0];
            let limitMins = 15;
            if (lastDiag.score >= 20) {
                limitMins = 15;
            } else if (lastDiag.score >= 10) {
                limitMins = 30;
            } else {
                limitMins = 60;
            }
            
            let activity = 'sns_other';
            if (lastDiag.type && lastDiag.type.includes('SNS')) {
                activity = 'sns_twitter';
            } else if (lastDiag.type && lastDiag.type.includes('ゲーム')) {
                activity = 'game_genshin';
            }
            
            const selectActivity = document.getElementById('select-activity');
            const inputLimitTime = document.getElementById('input-limit-time');
            if (selectActivity) selectActivity.value = activity;
            if (inputLimitTime) {
                inputLimitTime.value = limitMins;
                // プリセットボタンのアクティブ表示を更新するために時間表示をリフレッシュ
                const presetButtons = document.querySelectorAll('.btn-preset');
                presetButtons.forEach(b => {
                    if (parseInt(b.getAttribute('data-value')) === limitMins) {
                        b.classList.add('active');
                    } else {
                        b.classList.remove('active');
                    }
                });
                updateTimerDisplay(limitMins * 60, limitMins * 60);
            }
            
            resetTracker();
            startTracker();
            
            const trackerTabItem = document.querySelector('.nav-item[data-target="section-tracker"]');
            if (trackerTabItem) {
                trackerTabItem.click();
            }
        });
    }

    const btnGoTracker = document.getElementById('btn-go-tracker');
    if (btnGoTracker) {
        btnGoTracker.addEventListener('click', () => {
            // トラッカータブへ移動
            const trackerTabItem = document.querySelector('.nav-item[data-target="section-tracker"]');
            if (trackerTabItem) {
                trackerTabItem.click();
            }
        });
    }
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
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try {
        // Service Worker経由の通知は、タブがバックグラウンドでもより確実に表示される
        if (AppState.swRegistration && AppState.swRegistration.showNotification) {
            AppState.swRegistration.showNotification(title, options);
        } else {
            new Notification(title, options);
        }
    } catch (e) {
        console.error('通知の送信に失敗しました', e);
        // Service Worker経由が失敗した場合は通常のNotification APIにフォールバック
        try { new Notification(title, options); } catch (e2) { /* 何もできない */ }
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
    
    // パスコード制限チェック
    const checkLockTimer = document.getElementById('check-lock-timer');
    const lockEnabled = checkLockTimer ? checkLockTimer.checked : false;
    
    if (lockEnabled && !AppState.security.passcode) {
        alert('タイマー解除制限をかけるには、先にパスコードを設定する必要があります。「ロック設定」からパスコードを登録してください。');
        if (checkLockTimer) checkLockTimer.checked = false;
        openLockSetupModal();
        return;
    }
    
    AppState.security.lockTimerEnabled = lockEnabled;
    
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

    // バックグラウンド対応：実時刻を基準に経過時間を計算する
    AppState.tracker.startedAt = Date.now();
    AppState.tracker.pausedAt = null;
    AppState.tracker.totalPausedMs = 0;
    AppState.tracker.lastOvertimerNotificationTime = 0;

    requestWakeLock();
    saveTrackerState();

    // UIの制御
    document.getElementById('btn-start-tracker').classList.add('hidden');
    document.getElementById('btn-stop-tracker').classList.remove('hidden');
    document.getElementById('btn-reset-tracker').classList.remove('hidden');
    document.getElementById('select-activity').disabled = true;
    document.getElementById('input-limit-time').disabled = true;
    document.querySelectorAll('.btn-preset').forEach(b => b.disabled = true);
    if (checkLockTimer) checkLockTimer.disabled = true;
    
    const statusBadge = document.getElementById('tracker-status-badge');
    statusBadge.classList.remove('hidden');
    statusBadge.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${ACTIVITY_LABELS[activity]} 監視中`;

    const bgIndicator = document.getElementById('tracker-bg-indicator');
    if (bgIndicator) bgIndicator.classList.remove('hidden');

    // タイマーループの開始
    if (AppState.tracker.timerId) clearInterval(AppState.tracker.timerId);
    AppState.tracker.timerId = setInterval(updateTrackerTick, 1000);
    
    // 進捗表示の初期化
    const totalSeconds = AppState.tracker.limitSeconds;
    updateTimerDisplay(totalSeconds, totalSeconds);
    
    // ログと開始通知
    addLog('system', `${ACTIVITY_LABELS[activity]} の監視を開始しました。（目標：${limitMinutes}分${lockEnabled ? '・解除制限あり' : ''}）`);
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
    
    const performToggle = () => {
        const btnStop = document.getElementById('btn-stop-tracker');
        
        if (AppState.tracker.paused) {
            // 再開
            if (AppState.tracker.pausedAt) {
                AppState.tracker.totalPausedMs += (Date.now() - AppState.tracker.pausedAt);
                AppState.tracker.pausedAt = null;
            }
            AppState.tracker.paused = false;
            btnStop.innerHTML = '<i class="fa-solid fa-pause"></i> 一時停止';
            btnStop.className = 'btn btn-secondary btn-block';
            addLog('system', '監視を再開しました。');
            playBeepSound(800, 0.1, 'sine');
            requestWakeLock();
        } else {
            // 一時停止
            AppState.tracker.paused = true;
            AppState.tracker.pausedAt = Date.now();
            btnStop.innerHTML = '<i class="fa-solid fa-play"></i> 再開';
            btnStop.className = 'btn btn-primary btn-block';
            addLog('system', '監視を一時停止しました。');
            playBeepSound(500, 0.1, 'sine');
            releaseWakeLock();
        }
        saveTrackerState();
    };

    if (AppState.security.lockTimerEnabled && AppState.security.passcode) {
        showLockScreen(performToggle, "タイマーを一時停止／再開するには認証が必要です。");
    } else {
        performToggle();
    }
}

function resetTracker() {
    if (!AppState.tracker.active) return;
    
    const performReset = () => {
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
        releaseWakeLock();
        clearAppBadge();

        // 状態クリア
        AppState.tracker.active = false;
        AppState.tracker.paused = false;
        AppState.tracker.isOvertime = false;
        AppState.tracker.startedAt = null;
        AppState.tracker.pausedAt = null;
        AppState.tracker.totalPausedMs = 0;
        AppState.tracker.elapsedSeconds = 0;
        document.title = 'FocusGuard 🛡️ | スマホやりすぎ防止＆スケジュール連携';
        clearTrackerState();
        AppState.security.lockTimerEnabled = false; // 解除
        
        const checkLockTimer = document.getElementById('check-lock-timer');
        if (checkLockTimer) {
            checkLockTimer.checked = false;
            checkLockTimer.disabled = false;
        }
        
        // UI復元
        document.getElementById('btn-start-tracker').classList.remove('hidden');
        document.getElementById('btn-stop-tracker').classList.add('hidden');
        document.getElementById('btn-reset-tracker').classList.add('hidden');
        document.getElementById('select-activity').disabled = false;
        document.getElementById('input-limit-time').disabled = false;
        document.querySelectorAll('.btn-preset').forEach(b => b.disabled = false);
        
        document.getElementById('tracker-status-badge').classList.add('hidden');
        const bgIndicatorEl = document.getElementById('tracker-bg-indicator');
        if (bgIndicatorEl) bgIndicatorEl.classList.add('hidden');

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
    };

    if (AppState.security.lockTimerEnabled && AppState.security.passcode) {
        showLockScreen(performReset, "監視タイマーを終了するには認証が必要です。");
    } else {
        performReset();
    }
}

function updateTrackerTick() {
    if (!AppState.tracker.active || AppState.tracker.paused) return;

    // タイムスタンプとの差分から再計算するため、バックグラウンドでtickが
    // 間引かれたり止まったりしても、フォアグラウンドに戻った瞬間に正しい値へ復帰する
    AppState.tracker.elapsedSeconds = computeElapsedSeconds();

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
            updateAppBadge();

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

    // タブが非表示（バックグラウンド）の間はタブタイトルに残り時間を表示し、
    // タブを開かなくても状況が分かるようにする
    updateBackgroundTitle(remaining, elapsed, total);

    // 数秒おきにトラッカー状態を保存し、途中でブラウザが終了しても復元できるようにする
    if (elapsed % 5 === 0) {
        saveTrackerState();
    }
}

// バックグラウンド時のタブタイトル更新
function updateBackgroundTitle(remaining, elapsed, total) {
    if (!document.hidden) return;

    if (AppState.tracker.isOvertime) {
        const overMin = Math.floor((elapsed - total) / 60);
        const overSec = (elapsed - total) % 60;
        document.title = `🚨 ${String(overMin).padStart(2, '0')}:${String(overSec).padStart(2, '0')} 超過中！ - FocusGuard`;
    } else {
        const mm = Math.floor(remaining / 60);
        const ss = remaining % 60;
        document.title = `⏳ ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} 残り - FocusGuard`;
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
    const performClose = () => {
        document.getElementById('alert-modal').classList.add('hidden');
        document.body.classList.remove('fullscreen-warning-flash');
        stopAlertSiren();
        
        // トラッカーをリセット（やりすぎ警告の閉じるボタン ＝ ゲーム終了の意思表示とする）
        if (AppState.tracker.active) {
            // ロック確認は終わったので、一時的にフラグを倒してリセットする
            const backupLock = AppState.security.lockTimerEnabled;
            AppState.security.lockTimerEnabled = false;
            resetTracker();
            AppState.security.lockTimerEnabled = backupLock;
        }
    };

    if (AppState.tracker.active && AppState.security.lockTimerEnabled && AppState.security.passcode) {
        showLockScreen(performClose, "アラートを解除してアプリを終了するには認証が必要です。");
    } else {
        performClose();
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

// --- 診断機能用 質問データ＆ロジック ---
const DIAG_QUESTIONS = [
    "朝起きてすぐにスマートフォンをチェック（通知やSNS等を確認）しますか？",
    "スマホが手元にないとき、または電波がないときに不安やイライラを感じますか？",
    "食事中や、家族・友人との会話中にもスマホを触ってしまいますか？",
    "スマホの使いすぎが原因で、睡眠不足になったり翌朝起きるのが辛かったりしますか？",
    "スマホの使用時間を減らそうと決心しても、失敗してしまうことがありますか？",
    "勉強、仕事、家事などのやるべきことよりスマホを優先してしまうことがありますか？",
    "歩きスマホや、お風呂に入りながらのスマホ利用が習慣化していますか？",
    "スマホを使い始めると、気がついたらあっという間に数時間が経っていて驚くことがありますか？",
    "通知音が鳴っていないのに、鳴ったような気がして頻繁にスマホの画面を確認しますか？",
    "「スマホの使いすぎ」について、家族や周囲から注意されたり非難されたりしたことがありますか？"
];

function startDiagnosis() {
    initAudioContext();
    AppState.diagnosis.currentQuestionIdx = 0;
    AppState.diagnosis.scores = [];
    
    // UIの切り替え
    document.getElementById('diag-intro-card').classList.add('hidden');
    document.getElementById('diag-result-card').classList.add('hidden');
    document.getElementById('diag-question-card').classList.remove('hidden');
    
    renderDiagnosisQuestion();
    playBeepSound(700, 0.1, 'sine');
}

function renderDiagnosisQuestion() {
    const idx = AppState.diagnosis.currentQuestionIdx;
    const total = DIAG_QUESTIONS.length;
    
    // 質問文の更新
    document.getElementById('diag-question-text').textContent = `${idx + 1}. ${DIAG_QUESTIONS[idx]}`;
    
    // 進捗表示の更新
    document.getElementById('diag-progress-text').textContent = `質問 ${idx + 1} / ${total}`;
    
    const percent = Math.round(((idx + 1) / total) * 100);
    document.getElementById('diag-percent-text').textContent = `${percent}%`;
    document.getElementById('diag-progress-bar').style.width = `${percent}%`;
}

function handleDiagnosisAnswer(score) {
    AppState.diagnosis.scores.push(score);
    playBeepSound(800, 0.05, 'sine');
    
    AppState.diagnosis.currentQuestionIdx++;
    
    if (AppState.diagnosis.currentQuestionIdx < DIAG_QUESTIONS.length) {
        // 次の質問へ
        renderDiagnosisQuestion();
    } else {
        // 全問回答完了、結果表示へ
        finishDiagnosis();
    }
}

function finishDiagnosis() {
    const totalScore = AppState.diagnosis.scores.reduce((sum, s) => sum + s, 0);
    const scores = AppState.diagnosis.scores;
    
    // カテゴリ別のスコア集計
    const snsScore = (scores[0] || 0) + (scores[2] || 0) + (scores[8] || 0);
    const gameScore = (scores[7] || 0) + (scores[5] || 0);
    const habitScore = (scores[6] || 0) + (scores[3] || 0) + (scores[9] || 0);
    const mindScore = (scores[1] || 0) + (scores[4] || 0);

    // 診断タイプの特定
    let type = '健康健全タイプ';
    if (totalScore >= 8) {
        const categories = [
            { name: 'SNS中毒タイプ', score: snsScore },
            { name: 'ゲーム・動画没頭タイプ', score: gameScore },
            { name: 'ながらスマホ（生活乱れ）タイプ', score: habitScore },
            { name: 'スマホ不安（精神的依存）タイプ', score: mindScore }
        ];
        categories.sort((a, b) => b.score - a.score);
        type = categories[0].name;
    }

    let level = '';
    let levelClass = '';
    let desc = '';
    
    // 判定基準
    if (totalScore >= 20) {
        level = '依存度：高 (重度の疑い)';
        levelClass = 'diag-result-level-high';
    } else if (totalScore >= 10) {
        level = '依存度：中 (依存予備軍)';
        levelClass = 'diag-result-level-medium';
    } else {
        level = '依存度：低 (健康的な利用)';
        levelClass = 'diag-result-level-low';
    }
    
    // タイプ別のパーソナライズアドバイスの設定
    if (type === 'SNS中毒タイプ') {
        desc = `あなたはSNS（X/Twitter、Instagram等）や動画サイトの通知チェック、だらだら閲覧に依存している傾向が強い「SNS中毒タイプ」です。画面を開いていないときでも「いいね」や返信、新しい投稿が気になっていませんか？\n【対策】FocusGuardの「使用時間トラッカー」でSNSアプリ利用を1回15分に制限し、タイマー終了後はスマホの通知をオフにして没頭を防ぎましょう！`;
    } else if (type === 'ゲーム・動画没頭タイプ') {
        desc = `あなたはゲームや長時間の動画視聴（YouTube/TikTok等）に熱中するあまり、時間を忘れてしまう「ゲーム・動画没頭タイプ」です。気がつくと数時間が経過し、本来のやるべきことや睡眠時間が削られています。\n【対策】ゲーム開始前に必ず「制限時間（30分など）」をトラッカーに設定し、強力アラートが鳴ったらすぐにアプリをタスクキルする自己ルールを徹底してください。`;
    } else if (type === 'ながらスマホ（生活乱れ）タイプ') {
        desc = `あなたは歩きスマホ、お風呂、食事中、会話中など、あらゆる場面でスマホが手放せない「ながらスマホ（生活乱れ）タイプ」です。生活習慣の中にスマホが入り込みすぎており、周囲の注意を引いたり安全上のリスクもあります。\n【対策】スケジュール機能を使って「食事」「入浴」などの予定を登録し、予定時刻の数分前にスマホを「通知オフ」にして手の届かない場所に置く習慣をつけましょう。`;
    } else if (type === 'スマホ不安（精神的依存）タイプ') {
        desc = `あなたはスマホが手元にないことに強い不安やイライラを感じる「スマホ不安（精神的依存）タイプ」です。通知の幻聴が聞こえたり、何もなくても常に画面を点灯させて確認する癖がついています。\n【対策】まずは「スマホを触らない時間（デジタルデトックス）」を1日30分から設定し、FocusGuardのスケジュールを遵守した成功体験を積み重ねて不安を克服しましょう。`;
    } else {
        desc = `おめでとうございます！あなたはスマホと非常に健全かつ良好な距離感を保てている「健康健全タイプ」です。依存の兆候はほとんど見られません。今後も自分のペースを維持してスマホを役立つツールとして使いこなしてください！`;
    }
    
    // 結果UIの反映
    document.getElementById('diag-result-score').textContent = totalScore;
    const levelElement = document.getElementById('diag-result-level');
    levelElement.textContent = level;
    levelElement.className = levelClass;
    
    const typeElement = document.getElementById('diag-result-type');
    if (typeElement) {
        typeElement.textContent = `タイプ：${type}`;
    }
    
    document.getElementById('diag-result-desc').textContent = desc;
    
    // 切り替え
    document.getElementById('diag-question-card').classList.add('hidden');
    document.getElementById('diag-result-card').classList.remove('hidden');
    
    // 履歴に追加
    const now = new Date();
    const dateStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    AppState.diagnosis.history.unshift({
        date: dateStr,
        score: totalScore,
        level: level,
        levelClass: levelClass,
        type: type
    });
    
    // 履歴の上限を10件にする
    if (AppState.diagnosis.history.length > 10) {
        AppState.diagnosis.history.pop();
    }
    
    // ログに追記
    addLog('success', `スマホ依存度診断を実施しました（スコア: ${totalScore}点 / ${type}）`);
    
    // 保存と更新
    saveData();
    renderDiagHistory();
    
    // ファンファーレ音
    playBeepSound(500, 0.1, 'sine');
    setTimeout(() => playBeepSound(650, 0.1, 'sine'), 100);
    setTimeout(() => playBeepSound(800, 0.3, 'sine'), 200);
}

function resetDiagnosis() {
    AppState.diagnosis.currentQuestionIdx = 0;
    AppState.diagnosis.scores = [];
    
    document.getElementById('diag-result-card').classList.add('hidden');
    document.getElementById('diag-question-card').classList.add('hidden');
    document.getElementById('diag-intro-card').classList.remove('hidden');
    
    playBeepSound(500, 0.15, 'sine');
}

function renderDiagHistory() {
    const list = document.getElementById('diag-history-list');
    if (!list) return;
    
    const history = AppState.diagnosis.history;
    
    // SVG履歴グラフの再描画
    renderDiagHistoryChart();
    
    if (history.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-notes-medical"></i>
                <p>診断履歴はありません。</p>
            </div>
        `;
        return;
    }
    
    list.innerHTML = history.map(item => {
        const simpleLevel = item.level.split(' ')[0]; // 「依存度：高 (重度の疑い)」 から 「依存度：高」 を抽出
        const displayType = item.type ? ` | ${item.type.replace('タイプ', '')}` : '';
        return `
            <div class="diag-history-item">
                <div class="diag-hist-info">
                    <span class="diag-hist-level ${item.levelClass}">${escapeHtml(simpleLevel)}${escapeHtml(displayType)}</span>
                    <span class="diag-hist-date"><i class="fa-regular fa-calendar"></i> ${item.date}</span>
                </div>
                <div class="diag-hist-score">${item.score} <small>点</small></div>
            </div>
        `;
    }).join('');
}

// 診断スコア履歴の動的SVG折れ線グラフ描画
function renderDiagHistoryChart() {
    const svg = document.getElementById('diag-trend-chart');
    if (!svg) return;
    
    const history = AppState.diagnosis.history;
    // 履歴データをコピーし、時系列順（過去から現在）にするために反転（最大10件分）
    const data = [...history].slice(0, 10).reverse();
    
    // データが2点未満ならグラフ表示不可のテキスト
    if (data.length < 2) {
        svg.innerHTML = `
            <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="var(--text-secondary)" font-size="9" font-weight="600">
                履歴グラフの表示には診断が2回以上必要です。
            </text>
        `;
        return;
    }
    
    const svgWidth = 400;
    const svgHeight = 150;
    const paddingLeft = 30;
    const paddingRight = 15;
    const paddingTop = 15;
    const paddingBottom = 20;
    
    const chartWidth = svgWidth - paddingLeft - paddingRight;
    const chartHeight = svgHeight - paddingTop - paddingBottom;
    
    const maxVal = 30; // 満点30点
    const yRatio = chartHeight / maxVal;
    const xStep = chartWidth / (data.length - 1);
    
    // Y軸グリッド線とラベル
    let gridLines = '';
    const yTicks = [0, 10, 20, 30];
    yTicks.forEach(tick => {
        const y = paddingTop + chartHeight - (tick * yRatio);
        gridLines += `
            <line class="grid-line" x1="${paddingLeft}" y1="${y}" x2="${svgWidth - paddingRight}" y2="${y}"></line>
            <text x="${paddingLeft - 6}" y="${y + 2.5}" text-anchor="end" font-size="7">${tick}点</text>
        `;
    });
    
    // 折れ線、グラデーションエリア、ドットの構築
    let linePoints = [];
    let areaPoints = [];
    let plotPoints = '';
    let xLabels = '';
    
    // 最初の領域始点
    areaPoints.push(`${paddingLeft},${paddingTop + chartHeight}`);
    
    data.forEach((item, idx) => {
        const x = paddingLeft + (idx * xStep);
        const y = paddingTop + chartHeight - (item.score * yRatio);
        
        linePoints.push(`${x},${y}`);
        areaPoints.push(`${x},${y}`);
        
        // 最後の点の後に領域終点を追加
        if (idx === data.length - 1) {
            areaPoints.push(`${x},${paddingTop + chartHeight}`);
        }
        
        // 横軸ラベル（日付）
        const shortDate = item.date.split(' ')[0]; // 「6/16」
        xLabels += `
            <text x="${x}" y="${svgHeight - 6}" text-anchor="middle" font-size="7.5">${shortDate}</text>
        `;
        
        // プロットするホバー可能ドット
        const displayType = item.type ? ` (${item.type.replace('タイプ', '')})` : '';
        plotPoints += `
            <circle class="chart-point" cx="${x}" cy="${y}" r="3.5">
                <title>${item.date}\n点数: ${item.score}点\n${item.level.split(' ')[0]}${displayType}</title>
            </circle>
        `;
    });
    
    // SVGの中身を組み立ててレンダリング
    svg.innerHTML = `
        ${gridLines}
        <polygon class="chart-area" points="${areaPoints.join(' ')}"></polygon>
        <polyline class="chart-line" points="${linePoints.join(' ')}"></polyline>
        ${plotPoints}
        ${xLabels}
    `;
}

// --- セキュリティ・ロック画面・設定用ロジック ---

function openLockSetupModal() {
    initAudioContext();
    const modal = document.getElementById('lock-setup-modal');
    if (!modal) return;
    
    // パスコードが既に設定されているか
    if (AppState.security.passcode) {
        // 設定済みなら、設定パネルを表示してテンキー入力エリアは隠す
        document.getElementById('lock-setup-step1').classList.add('hidden');
        document.getElementById('lock-options-panel').classList.remove('hidden');
        
        // トグルの状態を合わせる
        const toggleAppLock = document.getElementById('toggle-app-lock');
        if (toggleAppLock) {
            toggleAppLock.checked = AppState.security.appLockEnabled;
        }
    } else {
        // 未設定なら、パスコード登録フローを初期起動
        initPasscodeSetupFlow();
    }
    
    modal.classList.remove('hidden');
    playBeepSound(600, 0.1, 'sine');
}

function initPasscodeSetupFlow() {
    AppState.security.setupStep = 1;
    AppState.security.tempInput = '';
    AppState.security.setupTempPasscode = '';
    
    document.getElementById('lock-options-panel').classList.add('hidden');
    document.getElementById('lock-setup-step1').classList.remove('hidden');
    
    const textEl = document.getElementById('lock-setup-text');
    if (textEl) textEl.textContent = '登録する4桁のパスコードを設定してください。';
    
    updateSetupDotsDisplay();
}

function handleSetupNumpadInput(val) {
    if (val === 'clear') {
        AppState.security.tempInput = '';
        updateSetupDotsDisplay();
        playBeepSound(400, 0.15, 'sine');
        return;
    }
    if (val === 'backspace') {
        AppState.security.tempInput = AppState.security.tempInput.slice(0, -1);
        updateSetupDotsDisplay();
        playBeepSound(500, 0.08, 'sine');
        return;
    }
    
    // 数字入力
    if (AppState.security.tempInput.length < 4) {
        AppState.security.tempInput += val;
        updateSetupDotsDisplay();
        playBeepSound(800, 0.08, 'sine');
    }
    
    // 4桁揃ったらステップ判定
    if (AppState.security.tempInput.length === 4) {
        setTimeout(() => {
            if (AppState.security.setupStep === 1) {
                // 1回目の入力完了 -> 2回目の確認へ
                AppState.security.setupTempPasscode = AppState.security.tempInput;
                AppState.security.tempInput = '';
                AppState.security.setupStep = 2;
                
                const textEl = document.getElementById('lock-setup-text');
                if (textEl) textEl.textContent = '確認のため、もう一度同じパスコードを入力してください。';
                updateSetupDotsDisplay();
                playBeepSound(600, 0.1, 'sine');
            } else if (AppState.security.setupStep === 2) {
                // 2回目の確認入力完了 -> 一致確認
                if (AppState.security.tempInput === AppState.security.setupTempPasscode) {
                    // 一致：登録完了
                    AppState.security.passcode = AppState.security.tempInput;
                    AppState.security.setupStep = 0;
                    saveData();
                    
                    // 音と演出
                    playBeepSound(500, 0.1, 'sine');
                    setTimeout(() => playBeepSound(750, 0.2, 'sine'), 100);
                    alert('パスコードを正常に設定しました！');
                    
                    // 設定パネルへ遷移
                    openLockSetupModal();
                } else {
                    // 不一致：やり直し
                    playBeepSound(300, 0.3, 'sawtooth');
                    alert('パスコードが一致しませんでした。もう一度やり直してください。');
                    initPasscodeSetupFlow();
                }
            }
        }, 150);
    }
}

function updateSetupDotsDisplay() {
    const dots = document.querySelectorAll('#lock-setup-dots .dot');
    const len = AppState.security.tempInput.length;
    dots.forEach((dot, idx) => {
        if (idx < len) {
            dot.classList.add('active');
        } else {
            dot.classList.remove('active');
        }
        dot.classList.remove('error');
    });
}

function disablePasscodeLock() {
    AppState.security.passcode = '';
    AppState.security.appLockEnabled = false;
    AppState.security.lockTimerEnabled = false;
    AppState.security.tempInput = '';
    AppState.security.setupStep = 0;
    saveData();
    
    // 設定モーダルを閉じる
    document.getElementById('lock-setup-modal').classList.add('hidden');
    addLog('system', 'セキュリティ・パスコードロックを無効化しました。');
    playBeepSound(400, 0.3, 'sine');
}

// --- ロック画面（全画面パスコード入力）の制御 ---

function showLockScreen(onSuccessCallback, message = '') {
    initAudioContext();
    const modal = document.getElementById('lock-screen-modal');
    if (!modal) return;
    
    AppState.security.lockScreenActive = true;
    AppState.security.tempInput = '';
    AppState.security.onUnlockCallback = onSuccessCallback;
    
    if (message) {
        document.getElementById('lock-screen-msg').textContent = message;
    } else {
        document.getElementById('lock-screen-msg').textContent = 'パスコードを入力してロックを解除してください。';
    }
    
    // 緊急バイパスパネルを閉じた状態にする
    document.getElementById('bypass-form').classList.add('hidden');
    document.getElementById('bypass-input').value = '';
    
    updateScreenDotsDisplay();
    modal.classList.remove('hidden');
    
    playBeepSound(400, 0.15, 'sine');
}

function handleScreenNumpadInput(val) {
    if (!AppState.security.lockScreenActive) return;
    
    if (val === 'clear') {
        AppState.security.tempInput = '';
        updateScreenDotsDisplay();
        playBeepSound(400, 0.15, 'sine');
        return;
    }
    if (val === 'backspace') {
        AppState.security.tempInput = AppState.security.tempInput.slice(0, -1);
        updateScreenDotsDisplay();
        playBeepSound(500, 0.08, 'sine');
        return;
    }
    
    // 数字入力
    if (AppState.security.tempInput.length < 4) {
        AppState.security.tempInput += val;
        updateScreenDotsDisplay();
        playBeepSound(800, 0.08, 'sine');
    }
    
    // 4桁揃ったらパスコード検証
    if (AppState.security.tempInput.length === 4) {
        setTimeout(() => {
            validatePasscode();
        }, 150);
    }
}

function updateScreenDotsDisplay() {
    const dots = document.querySelectorAll('#lock-screen-dots .dot');
    const len = AppState.security.tempInput.length;
    dots.forEach((dot, idx) => {
        if (idx < len) {
            dot.classList.add('active');
        } else {
            dot.classList.remove('active');
        }
        dot.classList.remove('error');
    });
}

function validatePasscode() {
    const input = AppState.security.tempInput;
    const target = AppState.security.passcode;
    
    if (input === target) {
        // ロック解除成功
        AppState.security.lockScreenActive = false;
        document.getElementById('lock-screen-modal').classList.add('hidden');
        
        playBeepSound(500, 0.1, 'sine');
        setTimeout(() => playBeepSound(800, 0.25, 'sine'), 80);
        addLog('success', 'セキュリティロックを解除しました。');
        
        // コールバックがある場合は実行
        if (typeof AppState.security.onUnlockCallback === 'function') {
            AppState.security.onUnlockCallback();
            AppState.security.onUnlockCallback = null;
        }
    } else {
        // パスコードエラー時の演出
        playBeepSound(250, 0.35, 'sawtooth');
        
        // エラーアニメーション（ドットを赤くして震えさせる）
        const dots = document.querySelectorAll('#lock-screen-dots .dot');
        dots.forEach(dot => {
            dot.classList.add('error');
        });
        
        // 1秒後にリセット
        setTimeout(() => {
            AppState.security.tempInput = '';
            updateScreenDotsDisplay();
        }, 1000);
    }
}

function handleEmergencyBypass() {
    const inputVal = document.getElementById('bypass-input').value.trim();
    const targetVal = document.getElementById('bypass-target-phrase').textContent.trim();
    
    if (inputVal === targetVal) {
        // 誓い成立による強制解除
        AppState.security.lockScreenActive = false;
        AppState.security.lockTimerEnabled = false; // 解除
        
        const checkLockTimer = document.getElementById('check-lock-timer');
        if (checkLockTimer) {
            checkLockTimer.checked = false;
            checkLockTimer.disabled = false;
        }
        
        document.getElementById('lock-screen-modal').classList.add('hidden');
        
        // 音響演出
        playBeepSound(500, 0.15, 'sine');
        setTimeout(() => playBeepSound(650, 0.15, 'sine'), 120);
        setTimeout(() => playBeepSound(900, 0.3, 'sine'), 240);
        
        addLog('alert', '【緊急解除】誓いの言葉のタイピングによってセキュリティロックが強制解除されました。');
        
        // 誓いの言葉入力を隠す
        document.getElementById('bypass-form').classList.add('hidden');
        
        // コールバック実行
        if (typeof AppState.security.onUnlockCallback === 'function') {
            AppState.security.onUnlockCallback();
            AppState.security.onUnlockCallback = null;
        }
        
        alert('誓いが承認されました。ロックを強制解除します。予定を優先してください！');
    } else {
        playBeepSound(250, 0.3, 'sawtooth');
        alert('入力された誓いの言葉が一字一句正確ではありません。句読点（。等）やスペース、変換が完全に一致しているか確認して再度タイピングしてください。');
    }
}
