// Utkarsh Drugs Agency - Admin SPA Logic
const root = document.getElementById('admin-root');
let activeView = 'dashboard';
let dashboardPoller;

const api = async (url, options = {}) => {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await res.json();
    if (res.status === 401) { renderLogin(); throw new Error('Unauthorized'); }
    if (!res.ok) { alert(data.error); throw new Error(data.error); }
    return data;
};

async function initAdmin() {
    try { await api('/api/admin/stats'); renderApp(); } 
    catch (e) { /* Unauthorized */ }
}

function renderLogin() {
    if(dashboardPoller) clearInterval(dashboardPoller);
    root.innerHTML = `
        <div style="height: 100vh; display: flex; justify-content: center; align-items: center;">
            <div class="clay" style="padding: 40px; width: 100%; max-width: 400px; text-align: center;">
                <h2 style="color: var(--primary); margin-bottom: 30px;"><i class="fas fa-lock"></i> Admin Login</h2>
                <form id="loginForm">
                    <input type="email" id="loginEmail" class="clay-inset" placeholder="Admin Email" required>
                    <input type="password" id="loginPass" class="clay-inset" placeholder="Password" required>
                    <button type="submit" class="clay-btn" style="width: 100%; margin-top: 20px; background: var(--primary); color: white;">Login</button>
                </form>
            </div>
        </div>
    `;
    document.getElementById('loginForm').onsubmit = async (e) => {
        e.preventDefault();
        try {
            await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: e.target.loginEmail.value, password: e.target.loginPass.value }) });
            initAdmin();
        } catch(err) { }
    };
}

function renderApp() {
    root.innerHTML = `
        <div class="sidebar clay">
            <h2 style="color: var(--primary); text-align: center;"><i class="fas fa-pills"></i> Utkarsh Admin</h2>
            <ul style="list-style: none; padding: 0; margin-top: 40px;">
                <li style="margin-bottom: 20px;"><button class="clay-btn" style="width:100%; text-align:left;" onclick="switchView('dashboard')"><i class="fas fa-chart-line"></i> Dashboard</button></li>
                <li style="margin-bottom: 20px;"><button class="clay-btn" style="width:100%; text-align:left;" onclick="switchView('medicines')"><i class="fas fa-box"></i> Medicines</button></li>
                <li style="margin-bottom: 20px;"><button class="clay-btn" style="width:100%; text-align:left;" onclick="switchView('bookings')"><i class="fas fa-shopping-bag"></i> Bookings</button></li>
                <li style="margin-top: 50px;"><button class="clay-btn danger" style="width:100%; text-align:left;" onclick="logout()"><i class="fas fa-sign-out-alt"></i> Logout</button></li>
            </ul>
        </div>
        <div class="main-content" id="main-content"></div>
    `;
    switchView('dashboard');
    dashboardPoller = setInterval(() => { if(activeView === 'dashboard') loadDashboard(); }, 15000);
}

async function logout() {
    await api('/api/admin/logout', { method: 'POST' });
    renderLogin();
}

function switchView(view) {
    activeView = view;
    if (view === 'dashboard') loadDashboard();
    if (view === 'medicines') loadMedicines();
    if (view === 'bookings') loadBookings();
}

async function loadDashboard() {
    const stats = await api('/api/admin/stats');
    document.getElementById('main-content').innerHTML = `
        <h2><i class="fas fa-chart-line"></i> Dashboard</h2>
        <div class="grid-4">
            <div class="clay" style="padding: 20px; text-align: center;"><h3>Total Medicines</h3><h1 style="color: var(--primary);">${stats.totalMeds}</h1></div>
            <div class="clay" style="padding: 20px; text-align: center;"><h3>Active Medicines</h3><h1 style="color: var(--success);">${stats.activeMeds}</h1></div>
            <div class="clay" style="padding: 20px; text-align: center;"><h3>Low/Out Stock</h3><h1 style="color: var(--danger);">${stats.lowStock} / ${stats.outOfStock}</h1></div>
            <div class="clay" style="padding: 20px; text-align: center;"><h3>Total Bookings</h3><h1 style="color: var(--primary);">${stats.totalBookings}</h1></div>
            <div class="clay" style="padding: 20px; text-align: center;"><h3>Pending Orders</h3><h1 style="color: var(--warning);">${stats.pendingBookings}</h1></div>
            <div class="clay" style="padding: 20px; text-align: center;"><h3>Today's Sales</h3><h1 style="color: var(--success);">₹${stats.todaySales}</h1></div>
        </div>
    `;
}

async function loadMedicines() {
    const meds = await api('/api/admin/medicines');
    document.getElementById('main-content').innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <h2><i class="fas fa-box"></i> Inventory Management</h2>
            <button class="clay-btn" onclick="openBulkAddModal()"><i class="fas fa-plus"></i> Bulk Add Medicines</button>
        </div>
        <div class="clay" style="padding: 20px; margin-top: 20px; overflow-x: auto;">
            <table>
                <thead><tr><th>Name</th><th>Category</th><th>Stock</th><th>MRP</th><th>Selling Price</th><th>Status</th></tr></thead>
                <tbody>
                    ${meds.map(m => `
                        <tr>
                            <td><strong>${m.name}</strong><br><small>${m.sku || 'N/A'}</small></td>
                            <td>${m.category}</td>
                            <td><span style="color: ${m.stock < 10 ? 'red' : 'green'}; font-weight:bold;">${m.stock}</span></td>
                            <td>₹${m.mrp}</td><td>₹${m.sellingPrice}</td>
                            <td>${m.active ? '<span style="color:green;">Active</span>' : '<span style="color:red;">Inactive</span>'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        <div id="bulkModal" class="modal hidden">
            <div class="clay modal-content" style="max-width: 95%;">
                <h2 style="display:flex; justify-content:space-between;">Bulk Add Medicines <i class="fas fa-times"
