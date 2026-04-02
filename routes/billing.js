const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification, getDurationFromPack, calculateSubscriptionEndDate } = require("../utils");

// ============================================================
// 📊 1. LISTER LES ABONNEMENTS
// ============================================================
router.get("/", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
  try {
    let query = supabase.from("abonnements").select(`
        *,
        patient:patient_id (id, nom_complet, formule, famille_user_id)
    `);

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

// ============================================================
// ✅ 2. PAIEMENT MANUEL (Coordinateur)
// ============================================================
router.post("/pay", middleware(["COORDINATEUR"]), async (req, res) => {
  const { abonnement_id, montant } = req.body;
  try {
    const paymentDate = new Date();
    
    const { data: abo, error: errAbo } = await supabase
      .from("abonnements")
      .update({
        montant_paye: montant,
        statut: "Payé",
        date_paiement: paymentDate.toISOString(),
      })
      .eq("id", abonnement_id)
      .select('*, patient:patients(id, nom_complet, famille_user_id, type_pack)')
      .single();

    if (errAbo) throw errAbo;

    if (abo && abo.patient) {
      const durationMonths = getDurationFromPack(abo.patient.type_pack);
      const endDate = calculateSubscriptionEndDate(paymentDate, durationMonths, 5);
      
      await supabase
        .from("patients")
        .update({ 
          statut_paiement: "A jour",
          date_dernier_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          duree_abonnement_mois: durationMonths
        })
        .eq("id", abo.patient.id);
      
      await supabase
        .from("abonnements")
        .update({
          date_fin_abonnement: endDate.toISOString(),
          duree_mois: durationMonths
        })
        .eq("id", abonnement_id);

      if (abo.patient.famille_user_id) {
        sendPushNotification(
          abo.patient.famille_user_id,
          "✅ Paiement validé",
          `Le paiement pour ${abo.patient.nom_complet} a été reçu. Abonnement valable ${durationMonths} mois.`,
          "/#billing"
        );
      }
    }

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 💳 3. GÉNÉRER UN LIEN FEDAPAY
// ============================================================
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
        metadata: { abonnement_id: abonnement_id },
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

// ============================================================
// ⚡ 4. WEBHOOK FEDAPAY (avec gestion des durées)
// ============================================================
router.post("/webhook", async (req, res) => {
  console.log("💰 [WEBHOOK] Signal reçu");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  
  const event = req.body;
  const signature = req.headers['x-fedapay-signature'];
  
  // Vérification de la signature
  if (!verifyWebhookSignature(signature, JSON.stringify(event))) {
    console.error("❌ [WEBHOOK] Signature invalide");
    return res.status(401).json({ error: "Signature invalide" });
  }
  
  // Traitement du paiement approuvé
  if (event.type === 'transaction.approved' || event.entity?.status === 'approved') {
    const transaction = event.entity;
    const abonnement_id = transaction.metadata?.abonnement_id;
    const montant_recu = transaction.amount;
    const reference = transaction.id;
    const moyen_paiement = transaction.payment_method?.type || 'FEDAPAY';
    
    if (!abonnement_id) {
      console.error("❌ [WEBHOOK] Pas d'abonnement_id");
      return res.sendStatus(200);
    }
    
    console.log(`✅ [FEDAPAY] Paiement confirmé - Facture: ${abonnement_id}, Montant: ${montant_recu} CFA`);
    
    try {
      // Récupérer l'abonnement
      const { data: abo, error: errAbo } = await supabase
        .from("abonnements")
        .select('*, patient:patients(id, nom_complet, famille_user_id, type_pack)')
        .eq("id", abonnement_id)
        .single();
      
      if (errAbo) throw errAbo;
      
      const paymentDate = new Date();
      const durationMonths = getDurationFromPack(abo.patient?.type_pack || abo.type_pack);
      const endDate = calculateSubscriptionEndDate(paymentDate, durationMonths, 5);
      
      // Mise à jour de la facture
      await supabase
        .from("abonnements")
        .update({
          montant_paye: montant_recu,
          statut: "Payé",
          date_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          duree_mois: durationMonths,
          reference_paiement: reference,
          mode_paiement: moyen_paiement
        })
        .eq("id", abonnement_id);
      
      if (abo && abo.patient) {
        // Mise à jour du patient
        await supabase
          .from("patients")
          .update({ 
            statut_paiement: "A jour",
            date_dernier_paiement: paymentDate.toISOString(),
            date_fin_abonnement: endDate.toISOString(),
            duree_abonnement_mois: durationMonths
          })
          .eq("id", abo.patient.id);
        
        const endDateFormatted = endDate.toLocaleDateString('fr-FR');
        
        if (abo.patient.famille_user_id) {
          await sendPushNotification(
            abo.patient.famille_user_id,
            "💎 Abonnement activé",
            `Paiement reçu pour ${abo.patient.nom_complet}. Abonnement valable ${durationMonths} mois jusqu'au ${endDateFormatted}.`,
            "/#dashboard"
          );
        }
        
        console.log(`✅ [WEBHOOK] Abonnement ${durationMonths} mois - Valable jusqu'au ${endDateFormatted}`);
      }
    } catch (err) {
      console.error("❌ [WEBHOOK ERROR]:", err.message);
    }
  }
  
  res.sendStatus(200);
});

// ============================================================
// 🩺 5. VÉRIFICATION DE L'ÉTAT DU WEBHOOK (Debug)
// ============================================================
router.get("/webhook/status", middleware(["COORDINATEUR"]), async (req, res) => {
  const webhookUrl = `${process.env.API_URL || 'https://sante-plus-backend-ux1n.onrender.com'}/api/billing/webhook`;
  
  res.json({
    status: "active",
    webhook_url: webhookUrl,
    secret_configured: !!process.env.FEDAPAY_WEBHOOK_SECRET,
    environment: process.env.NODE_ENV || 'production',
    last_webhook_calls: await getLastWebhookCalls()
  });
});

// ============================================================
// 📦 FONCTIONS UTILITAIRES
// ============================================================

/**
 * 🔐 Vérification de la signature webhook (une seule version)
 */
function verifyWebhookSignature(signature, payload) {
  // Mode développement - accepter tous les webhooks
  if (process.env.NODE_ENV === 'development') {
    console.log("⚠️ [WEBHOOK] Mode développement - signature non vérifiée");
    return true;
  }
  
  if (!signature || !process.env.FEDAPAY_WEBHOOK_SECRET) {
    console.error("❌ [WEBHOOK] Signature ou secret manquant");
    return false;
  }
  
  try {
    const expectedSignature = crypto
      .createHmac('sha256', process.env.FEDAPAY_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (err) {
    console.error("❌ [WEBHOOK] Erreur vérification signature:", err.message);
    return false;
  }
}

/**
 * 📊 Récupère les derniers appels webhook pour debug
 */
async function getLastWebhookCalls() {
  const { data } = await supabase
    .from("logs")
    .select("created_at, details, reference")
    .eq("action", "paiement_auto")
    .order("created_at", { ascending: false })
    .limit(10);
  
  return data || [];
}



/**
 * 📝 GÉNÉRER UNE FACTURE
 */
router.post("/generate", middleware(["FAMILLE"]), async (req, res) => {
    const { patient_id, montant, pack } = req.body;
    const monthYear = new Date().toLocaleDateString("fr-FR", {
        month: "2-digit",
        year: "numeric",
    });
    
    const { data, error } = await supabase
        .from("abonnements")
        .insert([{
            patient_id: patient_id,
            mois_annee: monthYear,
            montant_du: montant,
            statut: "En attente",
            type_pack: pack
        }])
        .select()
        .single();
    
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});
module.exports = router;
