import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? '${API}'
    : 'https://us-central1-xero-frontend.cloudfunctions.net/api';

const firebaseConfig = {
    apiKey: "AIzaSyCa7RTOSEIe5H1ALUrzUGgHKnenQbCvOW0",
    authDomain: "xero-frontend.firebaseapp.com",
    projectId: "xero-frontend",
    storageBucket: "xero-frontend.firebasestorage.app",
    messagingSenderId: "934269937850",
    appId: "1:934269937850:web:ee31b04aa12d6848263a83",
    measurementId: "G-MQE0KWCRRD"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const provider = new GoogleAuthProvider();

window.firebaseAuth = auth;

// Toast 通知（全域可用）
window.showNotification = function(message, type = 'success') {
    let el = document.getElementById('xero-notification');
    if (!el) {
        el = document.createElement('div');
        el.id = 'xero-notification';
        el.style.cssText = 'position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;font-size:14px;z-index:9999;color:#fff;transition:opacity 0.3s;max-width:320px;';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.background = type === 'success' ? '#10b981' : '#ef4444';
    el.style.opacity = '1';
    el.style.display = 'block';
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => { el.style.display = 'none'; }, 300);
    }, 3500);
};

// 處理 Xero OAuth 回調的 URL 參數
function handleXeroCallback() {
    const params = new URLSearchParams(window.location.search);
    const xeroParam = params.get('xero');
    if (!xeroParam) return;
    history.replaceState({}, '', window.location.pathname);
    if (xeroParam === 'connected') {
        window.showNotification('Xero 連結成功！');
    } else if (xeroParam === 'error') {
        const reason = params.get('reason') || '';
        const msg = {
            no_tenant: '找不到 Xero 組織，請確認帳號已加入公司',
            token_exchange: 'Token 交換失敗，請重試',
            server_error: '伺服器錯誤，請重試'
        }[reason] || '連結失敗，請重試';
        window.showNotification('Xero 連結失敗：' + msg, 'error');
    }
}

handleXeroCallback();

// Auth State Change
onAuthStateChanged(auth, async (user) => {
    const loginView = document.getElementById('login-view');
    const dashboardView = document.getElementById('dashboard-view');

    if (user) {
        loginView.classList.remove('active-view');
        dashboardView.classList.add('active-view');
        document.getElementById('user-name').innerText = user.displayName;
        document.getElementById('user-avatar').src = user.photoURL;
        await loadXeroTenants(user);
    } else {
        dashboardView.classList.remove('active-view');
        loginView.classList.add('active-view');
        resetXeroUI();
    }
});

async function loadXeroTenants(user) {
    try {
        const token = await user.getIdToken();
        const res = await fetch('${API}/xero/tenants', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();

        const statusText = document.getElementById('xero-connection-status');
        const statusDot = document.querySelector('.status-dot');
        const connectBtn = document.getElementById('connect-xero-btn');
        const tenantSection = document.getElementById('tenant-section');
        const tenantNameDisplay = document.getElementById('tenant-name-display');
        const switchBtn = document.getElementById('switch-tenant-btn');

        if (data.connected) {
            statusText.innerText = 'Xero 已連結';
            statusDot.classList.add('connected');
            connectBtn.style.display = 'none';

            // 顯示操作公司
            tenantSection.style.display = 'flex';
            tenantNameDisplay.innerText = data.activeTenantName || '-';

            // 若有多間公司，顯示切換按鈕
            if (data.tenants && data.tenants.length > 1) {
                switchBtn.style.display = 'inline-block';
            }

            // 全域狀態供 app.js 使用
            window.xeroTenants = data.tenants || [];
            window.xeroActiveTenantId = data.activeTenantId;
            window.xeroActiveTenantName = data.activeTenantName;

            // 更新設定頁面
            updateSettingsPanel(data);
        } else {
            statusText.innerText = 'Xero 未連結';
            statusDot.classList.remove('connected');
            connectBtn.style.display = 'inline-block';
            tenantSection.style.display = 'none';
        }
    } catch (e) {
        console.error('Failed to load Xero tenants:', e);
    }
}

function updateSettingsPanel(data) {
    const infoEl = document.getElementById('settings-xero-info');
    const tenantCard = document.getElementById('settings-tenant-card');
    const tenantListEl = document.getElementById('settings-tenant-list');

    if (infoEl) {
        infoEl.innerHTML = `
            <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">
                <span style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block"></span>
                <span style="font-weight:500">已成功連結 Xero</span>
            </div>
            <div style="font-size:0.8rem;color:var(--text-muted)">可使用帳號授權的所有功能</div>
        `;
    }

    if (tenantCard && data.tenants && data.tenants.length > 0) {
        tenantCard.style.display = 'block';
        tenantListEl.innerHTML = data.tenants.map(t => `
            <button class="tenant-option ${t.tenantId === data.activeTenantId ? 'active-tenant' : ''}"
                    data-id="${t.tenantId}" onclick="window.selectTenantFromSettings('${t.tenantId}')">
                <span class="tenant-dot"></span>
                ${t.tenantName}
                ${t.tenantId === data.activeTenantId ? ' ✓' : ''}
            </button>
        `).join('');
    }
}

function resetXeroUI() {
    document.getElementById('xero-connection-status').innerText = 'Xero 未連結';
    document.querySelector('.status-dot')?.classList.remove('connected');
    document.getElementById('connect-xero-btn').style.display = 'inline-block';
    document.getElementById('tenant-section').style.display = 'none';
    window.xeroTenants = [];
    window.xeroActiveTenantId = null;
    window.xeroActiveTenantName = null;
}

window.handleGoogleLogin = () => {
    signInWithPopup(auth, provider).catch(error => {
        console.error('Login Error:', error);
        window.showNotification('登入失敗：' + error.message, 'error');
    });
};

window.handleLogout = () => {
    signOut(auth).catch(error => console.error('Logout Error:', error));
};

window.connectXero = async () => {
    try {
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken();
        const res = await fetch('${API}/xero/auth-url', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.url) window.location.href = data.url;
    } catch (e) {
        console.error('Failed to get Xero Auth URL:', e);
        window.showNotification('無法取得 Xero 授權網址', 'error');
    }
};

// 從設定頁切換公司（全域供 inline onclick 使用）
window.selectTenantFromSettings = async (tenantId) => {
    await switchTenant(tenantId);
    window.onTenantChanged?.();
    const user = auth.currentUser;
    if (user) await loadXeroTenants(user);
};

export async function switchTenant(tenantId) {
    try {
        const user = auth.currentUser;
        if (!user) return null;
        const token = await user.getIdToken();
        const res = await fetch('${API}/xero/tenant/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ tenantId })
        });
        const data = await res.json();
        if (data.success) {
            window.xeroActiveTenantId = tenantId;
            window.xeroActiveTenantName = data.tenantName;
            document.getElementById('tenant-name-display').innerText = data.tenantName;
            window.showNotification(`已切換至 ${data.tenantName}`);
            return data.tenantName;
        }
        return null;
    } catch (e) {
        console.error('Switch tenant error:', e);
        return null;
    }
}
