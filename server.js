require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// --- ROUTES PUBLIQUES (SANS TOKEN) ---
app.get("/", (req, res) => res.send("Santé Plus Services API est en ligne !"));

const authRoutes = require("./routes/auth");
const billingRoutes = require("./routes/billing"); // Import billing

// ⚠️ IMPORTANT : On branche le webhook AVANT tout middleware de sécurité global si tu en ajoutes un.
// Le webhook FedaPay est déjà géré sans middleware dans son fichier route.
app.use("/api/auth", authRoutes);
app.use("/api/billing", billingRoutes);

// --- ROUTES PROTÉGÉES (AVEC MIDDLEWARE DÉJÀ INCLUS DANS LES FICHIERS) ---
const patientRoutes = require("./routes/patients");
const visitesRoutes = require("./routes/visites");
const messagesRoutes = require("./routes/messages");
const dashboardRoutes = require("./routes/dashboard");
const aidantRoutes = require("./routes/aidants");
const startCronJobs = require("./cron");

app.use("/api/dashboard", dashboardRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/visites", upload.any(), visitesRoutes);
app.use("/api/messages", upload.any(), messagesRoutes);
app.use("/api/aidants", aidantRoutes);
app.use("/api/commandes", require("./routes/commandes"));
app.use("/api/planning", require("./routes/planning"));

// Lancement du Robot (Cron)
startCronJobs();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`
  🚀 SERVEUR SANTÉ PLUS OPÉRATIONNEL
  ----------------------------------
  🌍 Port : ${PORT}
  🤖 Robot : Activé
  💳 FedaPay : Prêt
  ----------------------------------
  `);
});
