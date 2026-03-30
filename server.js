require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// --- CONFIGURATION DE SÉCURITÉ (CORS) ---
app.use(cors({
    origin: [
        'http://localhost:5500', 
        'http://127.0.0.1:5500', 
        'https://stevenckohr-pixel.github.io' // Ton frontend GitHub Pages
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// --- ROUTE DE SANTÉ (Health Check) ---
app.get("/", (req, res) => res.send("🚀 Santé Plus Services API est opérationnelle !"));

// --- IMPORTS DES MODULES MÉTIERS ---
const authRoutes = require("./routes/auth");
const billingRoutes = require("./routes/billing");
const patientRoutes = require("./routes/patients");
const visitesRoutes = require("./routes/visites");
const messagesRoutes = require("./routes/messages");
const dashboardRoutes = require("./routes/dashboard");
const aidantRoutes = require("./routes/aidants");
const adminRoutes = require("./routes/admin");
const startCronJobs = require("./cron");

// --- BRANCHEMENT DES ROUTES ---

// 1. Authentification & Facturation (Gestion interne des permissions)
app.use("/api/auth", authRoutes);
app.use("/api/billing", billingRoutes);

// 2. Gestion Administrative & Monitoring
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/aidants", aidantRoutes);
app.use("/api/patients", patientRoutes);

// 3. Opérations Terrain (Nécessitent la gestion de fichiers/photos)
app.use("/api/visites", upload.any(), visitesRoutes);
app.use("/api/messages", upload.any(), messagesRoutes);
app.use("/api/commandes", upload.any(), require("./routes/commandes")); // 💥 Ajout upload pour preuve livraison
app.use("/api/planning", require("./routes/planning"));

// --- LANCEMENT DES SYSTÈMES AUTOMATIQUES ---
startCronJobs(); // Robot de facturation et relance

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
