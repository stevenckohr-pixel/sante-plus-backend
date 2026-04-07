require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();

// ✅ Définir upload pour les routes qui en ont besoin
const upload = multer({ storage: multer.memoryStorage() });

// Servir les fichiers statiques
app.use('/assets', express.static('assets'));

// Limites augmentées
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Timeout global
app.use((req, res, next) => {
    req.setTimeout(60000);
    res.setTimeout(60000);
    next();
});

// CORS
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

// Health check
app.get("/", (req, res) => res.send("🚀 Santé Plus Services API opérationnelle"));

// ============================================================
// IMPORTS DES ROUTES
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
// BRANCHEMENT DES ROUTES
// ============================================================

app.use("/api/auth", authRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/aidants", aidantRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/visites", visitesRoutes);
app.use("/api/messages", messagesRoutes);  // ← SUPPRIMEZ upload.any()
app.use("/api/commandes", commandesRoutes);
app.use("/api/planning", planningRoutes);
app.use("/api/notifications", notificationsRoutes);

// Démarrer les tâches planifiées
startCronJobs();

// Démarrage
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
