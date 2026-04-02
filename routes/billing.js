const axios = require("axios");
const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils"); 

/**
 * 📊 1. LISTER LES ABONNEMENTS (Optimisé)
 */
router.get("/", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
  try {
    let query = supabase.from("abonnements").select(`
        *,
        patient:patient_id (id, nom_complet, formule, famille_user_id)
    `);

      // Vérifie que la famille ne voit que ses propres factures
      if (req.user.role === "FAMILLE") {
        const { data: patient } = await supabase
          .from("patients")
          .select("id")
          .eq("famille_user_id", req.user.userId)
          .single();
        
        if (!patient) return res.json([]);
        query = query.eq("patient_id", patient.id);
      }

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ 2. ENREGISTRER UN PAIEMENT MANUEL (Espèces / Chèque)
 */
router.post("/pay", middleware(["COORDINATEUR"]), async (req, res) => {
  const { abonnement_id, montant } = req.body;
  try {
    const { data: abo, error: errAbo } = await supabase
      .from("abonnements")
      .update({
        montant_paye: montant,
        statut: "Payé",
        date_paiement: new Date().toISOString(),
      })
      .eq("id", abonnement_id)
      .select('*, patient:patients(nom_complet, famille_user_id)')
      .single();

    if (errAbo) throw errAbo;

    // Déblocage immédiat de l'accès patient
    await supabase.from("patients").update({ statut_paiement: "A jour" }).eq("id", abo.patient_id);

    // 🔔 Notification Push à la famille
    if (abo.patient?.famille_user_id) {
        sendPushNotification(
            abo.patient.famille_user_id,
            "✅ Paiement validé",
            `Le paiement de l'abonnement pour ${abo.patient.nom_complet} a été reçu.`,
            "/#billing"
        );
    }

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 💳 3. GÉNÉRER UN LIEN FEDAPAY (Paiement Mobile Money / Carte)
 */
router.post("/generate-payment", middleware(["FAMILLE"]), async (req, res) => {
  const { abonnement_id, montant, email_client } = req.body;
  
  if (!process.env.FEDAPAY_SECRET_KEY)
    return res.status(500).json({ error: "Configuration FedaPay manquante sur le serveur." });

  try {
    const response = await axios.post(
      "https://api.fedapay.com/v1/transactions",
      {
        description: `Santé Plus - Facture #${abonnement_id.substring(0, 8)}`,
        amount: montant,
        currency: { iso: "XOF" },
        callback_url: "https://stevenckohr-pixel.github.io/sante-plus-frontend/#billing?status=success",
        metadata: { abonnement_id: abonnement_id }, // 👈 Crucial pour le Webhook
        customer: { email: email_client || "client@santeplus.bj" },
      },
      {
        headers: { Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}` },
      },
    );

    const transaction = response.data.v1 ? response.data.v1.transaction : response.data.transaction;
    res.json({ url: `https://checkout.fedapay.com/${transaction.token}` });
  } catch (err) {
    console.error("FedaPay Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Impossible de générer le lien de paiement." });
  }
});

/**
 * ⚡ 4. WEBHOOK UNIVERSEL (FedaPay, Stripe, etc.)
 * Cette route reçoit les confirmations de paiement en arrière-plan.
 */
router.post("/webhook", async (req, res) => {
  const event = req.body;
  
  console.log("💰 [WEBHOOK] Signal de paiement reçu...");

  // --- LOGIQUE FEDAPAY ---
  if (event.entity && event.entity.status === "approved") {
    const abonnement_id = event.entity.metadata?.abonnement_id;
    const montant_recu = event.entity.amount;

    if (abonnement_id) {
      console.log(`✅ [FEDAPAY] Validation auto pour la facture : ${abonnement_id}`);
      
      try {
        // 1. Mise à jour de la facture
        const { data: abo, error: errAbo } = await supabase
          .from("abonnements")
          .update({
            montant_paye: montant_recu,
            statut: "Payé",
            date_paiement: new Date().toISOString(),
          })
          .eq("id", abonnement_id)
          .select('*, patient:patients(nom_complet, famille_user_id)')
          .single();

        if (abo) {
          // 2. Déblocage automatique du patient
          await supabase.from("patients").update({ statut_paiement: "A jour" }).eq("id", abo.patient_id);
          
          // 3. 🔔 Notification Push de remerciement
          if (abo.patient?.famille_user_id) {
              sendPushNotification(
                  abo.patient.famille_user_id,
                  "💎 Merci pour votre confiance",
                  `Paiement reçu pour ${abo.patient.nom_complet}. Votre accès est actif !`,
                  "/#feed"
              );
          }
        }
      } catch (err) {
        console.error("❌ [WEBHOOK ERROR]:", err.message);
      }
    }
  }
  
  // --- LOGIQUE FUTURE (STRIPE / PAYPAL) ---
  // if (event.type === 'checkout.session.completed') { ... }

  res.sendStatus(200); // Réponse obligatoire à FedaPay
});

module.exports = router;
