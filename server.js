require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });



// Augmenter la limite de taille pour les uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// --- CONFIGURATION DE SÉCURITÉ (CORS) ---
app.use(cors({
    origin: [
        'https://stevenckohr-pixel.github.io',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json());

// --- ROUTE DE SANTÉ (Health Check) ---
app.get("/", (req, res) => res.send("🚀 Santé Plus Services API est opérationnelle !"));

// ============================================================
// ✅ IMPORTS DES ROUTES (TOUS LES IMPORTS ICI, AVANT DE LES UTILISER)
// ============================================================
const authRoutes = require("./routes/auth");
const billingRoutes = require("./routes/billing");
const patientRoutes = require("./routes/patients");
const visitesRoutes = require("./routes/visites");      // ← IMPORTANT : avant de l'utiliser
const messagesRoutes = require("./routes/messages");
const dashboardRoutes = require("./routes/dashboard");
const aidantRoutes = require("./routes/aidants");
const adminRoutes = require("./routes/admin");
const startCronJobs = require("./cron");
const assignmentRoutes = require("./routes/assignments");
const notificationsRoutes = require("./routes/notifications");
const commandesRoutes = require("./routes/commandes");
const planningRoutes = require("./routes/planning");

// ============================================================
// ✅ BRANCHEMENT DES ROUTES (APRÈS LES IMPORTS)
// ============================================================

// 1. Authentification & Facturation
app.use("/api/auth", authRoutes);
app.use("/api/billing", billingRoutes);

// 2. Gestion Administrative & Monitoring
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/aidants", aidantRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/assignments", assignmentRoutes);

// 3. Opérations Terrain (Nécessitent la gestion de fichiers/photos)
app.use("/api/visites", upload.any(), visitesRoutes);      // ← visitesRoutes est maintenant défini
app.use("/api/messages", upload.any(), messagesRoutes);
app.use("/api/commandes", upload.any(), commandesRoutes);
app.use("/api/planning", planningRoutes);

// 4. Notifications et Cron
app.use("/api/notifications", notificationsRoutes);
startCronJobs();

// --- DÉMARRAGE DU SERVEUR ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`
  ==============================================
  ✅ SERVEUR SANTÉ PLUS SERVICES EN LIGNE
  🌍 Port : ${PORT}
  🛠️ Environnement : Production / Render
  🤖 Robot Cron : Activé
  💳 FedaPay Webhook : Prêt
  ==============================================
  `);
});
