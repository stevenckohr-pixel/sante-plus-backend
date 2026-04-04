require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");

// ✅ Une seule déclaration de app
const app = express();

const upload = multer({ storage: multer.memoryStorage() });

// Servir les fichiers statiques (images)
app.use('/assets', express.static('assets'));
// Augmenter la limite de taille pour les uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));



// Ajoute ceci pour les uploads plus gros
app.use((req, res, next) => {
    if (req.method === 'POST' && req.url.includes('/deliver')) {
        // Pas de limite stricte pour cette route
        req.setTimeout(60000); // 60 secondes
    }
    next();
});

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

// --- ROUTE DE SANTÉ (Health Check) ---
app.get("/", (req, res) => res.send("🚀 Santé Plus Services API est opérationnelle !"));

// ============================================================
// ✅ IMPORTS DES ROUTES
// ============================================================
const authRoutes = require("./routes/auth");
const billingRoutes = require("./routes/billing");
const patientRoutes = require("./routes/patients");
const visitesRoutes = require("./routes/visites");
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
// ✅ BRANCHEMENT DES ROUTES
// ============================================================

app.use("/api/auth", authRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/aidants", aidantRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/visites", visitesRoutes);
app.use("/api/messages", upload.any(), messagesRoutes);
app.use("/api/commandes", upload.any(), commandesRoutes);
app.use("/api/planning", planningRoutes);
app.use("/api/notifications", notificationsRoutes);

// Démarrer les tâches planifiées
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
