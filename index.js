const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cookieParser());

// --- MONGODB CONNECTION CACHING FOR VERCEL ---
let isConnected = false;
const connectDB = async () => {
    if (isConnected) return;
    try {
        const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/utkarsh';
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
        isConnected = true;
        console.log('MongoDB Connected');
        await initializeAdmin();
    } catch (err) {
        console.error('MongoDB Connection Error:', err);
    }
};

// --- MONGODB SCHEMAS ---
const adminSchema = new mongoose.Schema({ email: { type: String, required: true, unique: true }, password: { type: String, required: true } });
const Admin = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

const medicineSchema = new mongoose.Schema({
    name: { type: String, required: true }, genericName: String, brand: String, manufacturer: String, composition: String,
    category: { type: String, required: true }, sku: { type: String, unique: true }, mrp: { type: Number, required: true },
    sellingPrice: { type: Number, required: true }, discountPercentage: Number, stock: { type: Number, default: 0 },
    packSize: String, prescriptionRequired: { type: Boolean, default: false }, imageUrl: String, description: String, active: { type: Boolean, default: true }
}, { timestamps: true });
medicineSchema.index({ name: 'text', brand: 'text', composition: 'text', genericName: 'text' });
const Medicine = mongoose.models.Medicine || mongoose.model('Medicine', medicineSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

const bookingSchema = new mongoose.Schema({
    bookingId: { type: String, unique: true },
    customerName: String, customerPhone: String, customerEmail: String,
    address: { house: String, area: String, landmark: String, city: String, state: String, pin: String },
    items: [{ medicine: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine' }, name: String, qty: Number, mrp: Number, price: Number }],
    subtotal: Number, deliveryCharge: Number, grandTotal: Number, paymentMethod: String,
    paymentStatus: { type: String, default: 'Pending' },
    orderStatus: { type: String, default: 'Booking Received' },
    statusHistory: [{ status: String, date: { type: Date, default: Date.now } }]
}, { timestamps: true });
const Booking = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);

// --- INITIALIZE FIRST ADMIN ---
const initializeAdmin = async () => {
    const count = await Admin.countDocuments();
    if (count === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        await Admin.create({ email: process.env.ADMIN_EMAIL, password: hash });
    }
};

// --- AUTH MIDDLEWARE ---
const auth = (req, res, next) => {
    const token = req.cookies.adminToken;
    if (!token) return res.status(401).json({ error: 'Unauthorized. Please login.' });
    try { req.admin = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret'); next(); }
    catch (e) { res.status(401).json({ error: 'Invalid Session' }); }
};

// --- API ROUTES ---
app.use(async (req, res, next) => { await connectDB(); next(); });

// Serve admin.js script
app.get('/admin.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(process.cwd(), 'admin.js'));
});

// Auth Routes
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    const admin = await Admin.findOne({ email });
    if (!admin || !(await bcrypt.compare(password, admin.password))) return res.status(401).json({ error: 'Invalid Credentials' });
    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '1d' });
    res.cookie('adminToken', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 86400000 });
    res.json({ success: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('adminToken'); res.json({ success: true }); });

// Public Medicine API
app.get('/api/medicines', async (req, res) => {
    try {
        const { search, category } = req.query;
        let query = { active: true };
        if (search) query.$text = { $search: search };
        if (category) query.category = category;
        const medicines = await Medicine.find(query).sort({ createdAt: -1 });
        res.json(medicines);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public Booking API (Atomic Inventory)
app.post('/api/bookings', async (req, res) => {
    try {
        const { items, customerName, customerPhone, customerEmail, address, paymentMethod } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

        let success = true;
        let deducted = [];
        let subtotal = 0;
        let validatedItems = [];

        for (let item of items) {
            const med = await Medicine.findOneAndUpdate(
                { _id: item.id, stock: { $gte: item.qty }, active: true },
                { $inc: { stock: -item.qty } },
                { new: true }
            );
            if (!med) { success = false; break; }
            deducted.push({ id: med._id, qty: item.qty });
            subtotal += (med.sellingPrice * item.qty);
            validatedItems.push({ medicine: med._id, name: med.name, qty: item.qty, mrp: med.mrp, price: med.sellingPrice });
        }

        if (!success) {
            for (let d of deducted) await Medicine.updateOne({ _id: d.id }, { $inc: { stock: d.qty } });
            return res.status(400).json({ error: 'Some items are out of stock or unavailable.' });
        }

        const counter = await Counter.findByIdAndUpdate('bookingId', { $inc: { seq: 1 } }, { new: true, upsert: true });
        const bookingId = `UDA-${new Date().getFullYear()}-${String(counter.seq).padStart(6, '0')}`;
        const deliveryCharge = subtotal > 500 ? 0 : 50; // Configurable threshold

        const booking = await Booking.create({
            bookingId, customerName, customerPhone, customerEmail, address,
            items: validatedItems, subtotal, deliveryCharge, grandTotal: subtotal + deliveryCharge, paymentMethod,
            statusHistory: [{ status: 'Booking Received' }]
        });

        res.json({ success: true, bookingId: booking.bookingId });
    } catch (e) { res.status(500).json({ error: 'Server error processing booking.' }); }
});

// Order Tracking API (Requires Phone Verification)
app.post('/api/track', async (req, res) => {
    const { bookingId, phone } = req.body;
    const booking = await Booking.findOne({ bookingId }).populate('items.medicine');
    if (!booking || booking.customerPhone !== phone) return res.status(404).json({ error: 'Booking not found or verification failed. Check phone number.' });
    res.json(booking);
});

// --- ADMIN SECURE APIs ---
app.get('/api/admin/stats', auth, async (req, res) => {
    const totalMeds = await Medicine.countDocuments();
    const activeMeds = await Medicine.countDocuments({ active: true });
    const lowStock = await Medicine.countDocuments({ stock: { $lt: 10 } });
    const outOfStock = await Medicine.countDocuments({ stock: 0 });
    const totalBookings = await Booking.countDocuments();
    const pendingBookings = await Booking.countDocuments({ orderStatus: { $in: ['Booking Received', 'Processing'] } });
    
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayBookings = await Booking.find({ createdAt: { $gte: today } });
    const todaySales = todayBookings.reduce((sum, b) => sum + b.grandTotal, 0);

    res.json({ totalMeds, activeMeds, lowStock, outOfStock, totalBookings, pendingBookings, todaySales });
});

app.get('/api/admin/medicines', auth, async (req, res) => res.json(await Medicine.find().sort({ createdAt: -1 })));

app.post('/api/admin/medicines/bulk', auth, async (req, res) => {
    try {
        const items = req.body;
        for (let item of items) {
            item.sku = item.sku || `SKU-${Date.now()}-${Math.floor(Math.random()*1000)}`;
            await Medicine.create(item);
        }
        res.json({ success: true, message: `${items.length} medicines added.` });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/medicines/:id', auth, async (req, res) => {
    try { await Medicine.findByIdAndUpdate(req.params.id, req.body); res.json({ success: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/bookings', auth, async (req, res) => {
    const bookings = await Booking.find().sort({ createdAt: -1 });
    res.json(bookings);
});

app.put('/api/admin/bookings/:id/status', auth, async (req, res) => {
    try {
        const { orderStatus, paymentStatus } = req.body;
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Not found' });

        if (orderStatus && orderStatus !== booking.orderStatus) {
            booking.orderStatus = orderStatus;
            booking.statusHistory.push({ status: orderStatus, date: new Date() });
            
            // Stock Restoration Logic safely
            if (orderStatus === 'Cancelled' || orderStatus === 'Rejected') {
                for (let item of booking.items) {
                    await Medicine.updateOne({ _id: item.medicine }, { $inc: { stock: item.qty } });
                }
            }
        }
        if (paymentStatus) booking.paymentStatus = paymentStatus;
        await booking.save();
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- FRONTEND ROUTES ---
app.get('/admin', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Dashboard | Utkarsh Drugs</title>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
            :root { --bg: #e6eef5; --text: #2d3748; --primary: #2a73c5; --primary-dark: #1e5ba3; --success: #10b981; --danger: #ef4444; --warning: #f59e0b; }
            body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; }
            .clay { background: var(--bg); border-radius: 16px; box-shadow: 10px 10px 20px #c5d0db, -10px -10px 20px #ffffff; }
            .clay-inset { background: var(--bg); box-shadow: inset 5px 5px 10px #c5d0db, inset -5px -5px 10px #ffffff; border-radius: 12px; border: none; }
            .clay-btn { background: var(--bg); border: none; border-radius: 12px; box-shadow: 6px 6px 12px #c5d0db, -6px -6px 12px #ffffff; padding: 10px 20px; font-weight: 600; cursor: pointer; color: var(--primary); transition: 0.2s; }
            .clay-btn:active { box-shadow: inset 4px 4px 8px #c5d0db, inset -4px -4px 8px #ffffff; }
            .clay-btn.danger { color: var(--danger); }
            input, select, textarea { padding: 12px; width: 100%; box-sizing: border-box; outline: none; margin-bottom: 15px; }
            .sidebar { width: 250px; height: 100vh; position: fixed; padding: 20px; box-sizing: border-box; }
            .main-content { margin-left: 250px; padding: 30px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { padding: 15px; text-align: left; border-bottom: 1px solid #c5d0db; }
            .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000; }
            .modal-content { width: 90%; max-width: 800px; max-height: 90vh; overflow-y: auto; padding: 30px; }
            .hidden { display: none !important; }
            .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
            @media(max-width: 768px) { .sidebar { display: none; } .main-content { margin-left: 0; } }
        </style>
    </head>
    <body>
        <div id="admin-root"></div>
        <script src="/admin.js"></script>
    </body>
    </html>
    `);
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Utkarsh Drugs Agency | Online Booking</title>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            :root { --bg: #e6eef5; --text: #1e293b; --primary: #2a73c5; --success: #10b981; --accent: #a78bfa; }
            body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding-top: 80px; }
            .clay { background: var(--bg); border-radius: 20px; box-shadow: 12px 12px 24px #c5d0db, -12px -12px 24px #ffffff; }
            .clay-inset { background: var(--bg); box-shadow: inset 6px 6px 12px #c5d0db, inset -6px -6px 12px #ffffff; border-radius: 12px; border: none; padding: 12px; }
            .clay-btn { background: var(--bg); border: none; border-radius: 12px; box-shadow: 6px 6px 12px #c5d0db, -6px -6px 12px #ffffff; padding: 12px 24px; font-weight: bold; cursor: pointer; color: var(--primary); transition: 0.3s; }
            .clay-btn:active { box-shadow: inset 4px 4px 8px #c5d0db, inset -4px -4px 8px #ffffff; }
            .clay-btn.primary { background: var(--primary); color: white; box-shadow: 6px 6px 12px rgba(42,115,197,0.4); }
            nav { position: fixed; top: 0; width: 100%; padding: 15px 5%; box-sizing: border-box; display: flex; justify-content: space-between; align-items: center; z-index: 1000; }
            .hero { padding: 60px 20px; text-align: center; }
            .med-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; padding: 20px 5%; }
            .med-card { padding: 20px; text-align: center; transition: transform 0.3s; }
            .med-card:hover { transform: translateY(-5px); }
            .med-img { width: 100%; height: 200px; object-fit: contain; border-radius: 12px; margin-bottom: 15px; }
            .price { font-size: 1.2rem; font-weight: bold; color: var(--primary); }
            .mrp { text-decoration: line-through; color: #94a3b8; font-size: 0.9rem; }
            .modal { position: fixed; top:0; left:0; width:100%; height:100%; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1001; }
            .modal-content { width: 90%; max-width: 600px; max-height: 90vh; overflow-y: auto; padding: 30px; }
            .hidden { display: none !important; }
            .timeline { margin: 30px 0; padding: 0; list-style: none; border-left: 3px solid #c5d0db; padding-left: 20px; }
            .timeline li { position: relative; margin-bottom: 20px; padding-left: 15px; }
            .timeline li::before { content: ''; position: absolute; left: -28px; top: 0; width: 12px; height: 12px; background: var(--primary); border-radius: 50%; box-shadow: 0 0 0 4px var(--bg); }
            .timeline li.passed::before { background: var(--success); }
            #toast { position: fixed; bottom: 20px; right: 20px; padding: 15px 25px; border-radius: 12px; background: var(--success); color: white; transform: translateY(100px); opacity: 0; transition: 0.3s; z-index: 2000; }
        </style>
    </head>
    <body>
        <nav class="clay">
            <h2 style="margin: 0; color: var(--primary);"><i class="fas fa-pills"></i> Utkarsh Drugs</h2>
            <div style="display: flex; gap: 15px;">
                <button class="clay-btn" onclick="showView('home')"><i class="fas fa-home"></i> Home</button>
                <button class="clay-btn" onclick="showView('tracking')"><i class="fas fa-map-marker-alt"></i> Track Order</button>
                <button class="clay-btn" onclick="toggleCart()"><i class="fas fa-shopping-cart"></i> (<span id="cart-count">0</span>)</button>
            </div>
        </nav>

        <div id="toast">Message</div>

        <main id="view-home">
            <div class="hero">
                <h1 style="font-size: 2.5rem; color: var(--primary);">Your Trusted Pharmaceutical Partner</h1>
                <p style="font-size: 1.2rem; color: #64748b; margin-bottom: 30px;">Genuine Medicines, Delivered Safely.</p>
                <div style="max-width: 600px; margin: auto; position: relative;">
                    <input type="text" id="searchBar" class="clay-inset" placeholder="Search medicines by name, brand, or composition..." style="width: 100%; padding: 15px 20px; font-size: 1.1rem; outline: none;" oninput="debounceSearch()">
                </div>
            </div>
            <div class="med-grid" id="med-container"></div>
        </main>

        <main id="view-tracking" class="hidden" style="padding: 40px 5%; max-width: 800px; margin: auto;">
            <div class="clay" style="padding: 40px; text-align: center;">
                <h2 style="color: var(--primary);"><i class="fas fa-search-location"></i> Find My Booking</h2>
                <p>Enter your Booking ID and Mobile Number to track your order.</p>
                <input type="text" id="trackId" class="clay-inset" placeholder="Booking ID (e.g., UDA-2026-000001)" style="margin-top: 15px;">
                <input type="text" id="trackPhone" class="clay-inset" placeholder="Registered Mobile Number" style="margin-top: 15px;">
                <button class="clay-btn primary" style="margin-top: 25px;" onclick="trackOrder()">Track Order</button>
                
                <div id="trackResult" class="hidden" style="margin-top: 40px; text-align: left; padding-top: 30px; border-top: 1px solid #c5d0db;"></div>
            </div>
        </main>

        <div id="cartModal" class="modal hidden">
            <div class="clay modal-content">
                <h2 style="display: flex; justify-content: space-between;">Shopping Cart <i class="fas fa-times" style="cursor:pointer;" onclick="toggleCart()"></i></h2>
                <div id="cartItems" style="margin: 20px 0; max-height: 300px; overflow-y: auto;"></div>
                <div style="border-top: 1px solid #c5d0db; padding-top: 15px; text-align: right;">
                    <h3>Subtotal: ₹<span id="cartSubtotal">0</span></h3>
                    <p>Delivery: ₹<span id="cartDelivery">0</span></p>
                    <h2 style="color: var(--primary);">Grand Total: ₹<span id="cartTotal">0</span></h2>
                </div>
                <button class="clay-btn primary" style="width: 100%; margin-top: 20px;" onclick="openCheckout()">Proceed to Checkout</button>
            </div>
        </div>

        <div id="checkoutModal" class="modal hidden">
            <div class="clay modal-content">
                <h2 style="display: flex; justify-content: space-between;">Checkout <i class="fas fa-times" style="cursor:pointer;" onclick="document.getElementById('checkoutModal').classList.add('hidden')"></i></h2>
                <form id="checkoutForm" onsubmit="submitOrder(event)">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <input type="text" id="cName" class="clay-inset" placeholder="Full Name" required>
                        <input type="text" id="cPhone" class="clay-inset" placeholder="Mobile Number" required>
                        <input type="email" id="cEmail" class="clay-inset" placeholder="Email Address" required style="grid-column: span 2;">
                        <input type="text" id="cHouse" class="clay-inset" placeholder="House/Flat No." required>
                        <input type="text" id="cArea" class="clay-inset" placeholder="Area/Locality" required>
                        <input type="text" id="cCity" class="clay-inset" placeholder="City" required>
                        <input type="text" id="cPin" class="clay-inset" placeholder="PIN Code" required>
                        <select id="cPayment" class="clay-inset" style="grid-column: span 2;">
                            <option value="Cash on Delivery">Cash on Delivery</option>
                            <option value="Online Payment">Online Payment (Secure)</option>
                        </select>
                    </div>
                    <button type="submit" class="clay-btn primary" style="width: 100%; margin-top: 20px;" id="checkoutBtn">Confirm Booking</button>
                </form>
            </div>
        </div>

        <script>
            let cart = JSON.parse(localStorage.getItem('uda_cart')) || [];
            let medicines = [];
            let searchTimeout;

            function showToast(msg) {
                const t = document.getElementById('toast');
                t.innerText = msg; t.style.opacity = 1; t.style.transform = 'translateY(0)';
                setTimeout(() => { t.style.opacity = 0; t.style.transform = 'translateY(100px)'; }, 3000);
            }

            function showView(view) {
                document.getElementById('view-home').classList.add('hidden');
                document.getElementById('view-tracking').classList.add('hidden');
                document.getElementById('view-' + view).classList.remove('hidden');
            }

            async function fetchMedicines(query = '') {
                try {
                    const res = await fetch('/api/medicines' + (query ? '?search='+query : ''));
                    medicines = await res.json();
                    renderMedicines();
                } catch(e) { showToast('Error loading medicines'); }
            }

            function debounceSearch() {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    const val = document.getElementById('searchBar').value;
                    fetchMedicines(val);
                }, 500);
            }

            function renderMedicines() {
                const c = document.getElementById('med-container');
                c.innerHTML = medicines.map(m => \`
                    <div class="clay med-card">
                        <img src="\${m.imageUrl || 'https://images.unsplash.com/photo-1584308666744-24d5e4a3b118?auto=format&fit=crop&w=300&q=80'}" class="med-img" alt="\${m.name}">
                        <h3 style="margin: 10px 0; color: var(--primary);">\${m.name}</h3>
                        <p style="color: #64748b; font-size: 0.9rem; margin-bottom:15px;">\${m.composition || m.genericName}</p>
                        <div style="margin-bottom: 20px;">
                            <span class="mrp">₹\${m.mrp}</span>
                            <span class="price" style="margin-left: 10px;">₹\${m.sellingPrice}</span>
                            <span style="color: var(--success); font-weight: bold; margin-left:10px;">(\${Math.round((m.mrp - m.sellingPrice)/m.mrp * 100)}% OFF)</span>
                        </div>
                        \${m.stock > 0 ? 
                            \`<button class="clay-btn" onclick="addToCart('\${m._id}')"><i class="fas fa-cart-plus"></i> Add to Cart</button>\` : 
                            \`<button class="clay-btn" style="color:var(--danger); cursor:not-allowed;" disabled>Out of Stock</button>\`}
                    </div>
                \`).join('');
            }

            function addToCart(id) {
                const med = medicines.find(m => m._id === id);
                if(!med) return;
                const existing = cart.find(i => i.id === id);
                if(existing) {
                    if(existing.qty >= med.stock) return showToast('Maximum stock reached');
                    existing.qty++;
                } else {
                    cart.push({ id, name: med.name, price: med.sellingPrice, qty: 1, stock: med.stock });
                }
                saveCart();
                showToast(med.name + ' added to cart');
            }

            function saveCart() {
                localStorage.setItem('uda_cart', JSON.stringify(cart));
                document.getElementById('cart-count').innerText = cart.reduce((sum, i)=>sum+i.qty, 0);
                renderCart();
            }

            function toggleCart() {
                document.getElementById('cartModal').classList.toggle('hidden');
                renderCart();
            }

            function renderCart() {
                const c = document.getElementById('cartItems');
                if(cart.length === 0) { c.innerHTML = '<p>Cart is empty</p>'; updateCartTotals(); return; }
                c.innerHTML = cart.map((i, index) => \`
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #c5d0db;">
                        <div>
                            <h4 style="margin: 0;">\${i.name}</h4>
                            <p style="margin: 5px 0 0; color: var(--primary);">₹\${i.price} x \${i.qty} = ₹\${i.price * i.qty}</p>
                        </div>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <button class="clay-inset" style="padding: 5px 10px; cursor: pointer;" onclick="updateQty(\${index}, -1)">-</button>
                            <span>\${i.qty}</span>
                            <button class="clay-inset" style="padding: 5px 10px; cursor: pointer;" onclick="updateQty(\${index}, 1)">+</button>
                            <i class="fas fa-trash" style="color: var(--danger); cursor: pointer; margin-left: 10px;" onclick="removeFromCart(\${index})"></i>
                        </div>
                    </div>
                \`).join('');
                updateCartTotals();
            }

            function updateQty(index, change) {
                cart[index].qty += change;
                if(cart[index].qty > cart[index].stock) { cart[index].qty--; showToast('Stock limit reached'); }
                if(cart[index].qty <= 0) cart.splice(index, 1);
                saveCart();
            }
            function removeFromCart(index) { cart.splice(index, 1); saveCart(); }

            function updateCartTotals() {
                const sub = cart.reduce((sum, i) => sum + (i.price * i.qty), 0);
                const del = (sub > 0 && sub < 500) ? 50 : 0;
                document.getElementById('cartSubtotal').innerText = sub;
                document.getElementById('cartDelivery').innerText = del;
                document.getElementById('cartTotal').innerText = sub + del;
            }

            function openCheckout() {
                if(cart.length === 0) return showToast('Cart is empty');
                document.getElementById('cartModal').classList.add('hidden');
                document.getElementById('checkoutModal').classList.remove('hidden');
            }

            async function submitOrder(e) {
                e.preventDefault();
                const btn = document.getElementById('checkoutBtn');
                btn.innerText = 'Processing...'; btn.disabled = true;

                const payload = {
                    items: cart,
                    customerName: document.getElementById('cName').value,
                    customerPhone: document.getElementById('cPhone').value,
                    customerEmail: document.getElementById('cEmail').value,
                    address: {
                        house: document.getElementById('cHouse').value, area: document.getElementById('cArea').value,
                        city: document.getElementById('cCity').value, pin: document.getElementById('cPin').value
                    },
                    paymentMethod: document.getElementById('cPayment').value
                };

                try {
                    if(payload.paymentMethod === 'Online Payment') await new Promise(r => setTimeout(r, 2000)); // Mock gateway

                    const res = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    const data = await res.json();
                    
                    if(res.ok) {
                        cart = []; saveCart();
                        document.getElementById('checkoutModal').classList.add('hidden');
                        showToast('Booking Successful! ID: ' + data.bookingId);
                        document.getElementById('trackId').value = data.bookingId;
                        document.getElementById('trackPhone').value = payload.customerPhone;
                        showView('tracking');
                        trackOrder();
                    } else {
                        showToast(data.error);
                    }
                } catch(e) { showToast('Error processing booking'); }
                btn.innerText = 'Confirm Booking'; btn.disabled = false;
            }

            async function trackOrder() {
                const id = document.getElementById('trackId').value;
                const phone = document.getElementById('trackPhone').value;
                if(!id || !phone) return showToast('Enter Booking ID and Phone');

                const res = await fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: id, phone }) });
                const data = await res.json();

                const r = document.getElementById('trackResult');
                if(!res.ok) { r.classList.add('hidden'); return showToast(data.error); }

                r.classList.remove('hidden');
                const statuses = ['Booking Received', 'Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered'];
                let currentIdx = statuses.indexOf(data.orderStatus);
                if (data.orderStatus === 'Cancelled' || data.orderStatus === 'Rejected') statuses.push(data.orderStatus);

                r.innerHTML = \`
                    <div style="display: flex; justify-content: space-between; flex-wrap: wrap;">
                        <div>
                            <h3>Booking ID: <span style="color:var(--primary);">\${data.bookingId}</span></h3>
                            <p>Date: \${new Date(data.createdAt).toLocaleString()}</p>
                            <p>Total Amount: ₹\${data.grandTotal}</p>
                            <p>Payment: \${data.paymentMethod} - <strong>\${data.paymentStatus}</strong></p>
                        </div>
                    </div>
                    <h4>Tracking Timeline</h4>
                    <ul class="timeline">
                        \${data.statusHistory.map(s => \`<li class="passed">\${s.status} <span style="font-size:0.8rem; color:#64748b; margin-left:10px;">\${new Date(s.date).toLocaleString()}</span></li>\`).join('')}
                    </ul>
                    <h4>Items</h4>
                    \${data.items.map(i => \`<p>\${i.name} x \${i.qty} = ₹\${i.price * i.qty}</p>\`).join('')}
                \`;
            }

            // Sync polling
            setInterval(() => { if(!document.getElementById('view-home').classList.contains('hidden')) fetchMedicines(); }, 15000);
            
            fetchMedicines();
            saveCart();
        </script>
    </body>
    </html>
    `);
});

module.exports = app;
