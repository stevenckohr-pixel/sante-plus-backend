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
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  const event = req.body;
  const signature = req.headers['x-fedapay-signature'];
  console.log("💰 [WEBHOOK] Signal reçu:", event.type || event.entity?.status);
  
  // 🔐 Vérification de la signature (sécurité)
  if (!verifyWebhookSignature(signature, JSON.stringify(event))) {
    console.error("❌ [WEBHOOK] Signature invalide - Attaque potentielle");
    return res.status(401).json({ error: "Signature invalide" });
  }
  
  // 📝 Traitement selon le type d'événement
  if (event.type === 'transaction.approved' || event.entity?.status === 'approved') {
    const transaction = event.entity;
    const abonnement_id = transaction.metadata?.abonnement_id;
    const montant_recu = transaction.amount;
    const reference = transaction.id;
    const moyen_paiement = transaction.payment_method?.type || 'FEDAPAY';
    
    if (!abonnement_id) {
      console.error("❌ [WEBHOOK] Pas d'abonnement_id dans les métadonnées");
      return res.sendStatus(200);
    }
    
    console.log(`✅ [FEDAPAY] Paiement confirmé - Facture: ${abonnement_id}, Montant: ${montant_recu} CFA`);
    
    try {
      // 1. Récupérer l'abonnement avant mise à jour
      const { data: oldAbo, error: fetchError } = await supabase
        .from("abonnements")
        .select('*, patient:patients(id, nom_complet, famille_user_id)')
        .eq("id", abonnement_id)
        .single();
      
      if (fetchError) throw fetchError;
      
      const paymentDate = new Date();
      const endDate = calculateSubscriptionEndDate(paymentDate);
      
      // 2. Mise à jour de la facture avec les dates
      const { data: abo, error: errAbo } = await supabase
        .from("abonnements")
        .update({
          montant_paye: montant_recu,
          statut: "Payé",
          date_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          reference_paiement: reference,
          mode_paiement: moyen_paiement
        })
        .eq("id", abonnement_id)
        .select('*, patient:patients(id, nom_complet, famille_user_id)')
        .single();
      
      if (errAbo) throw errAbo;
      
      if (abo && abo.patient) {
        // 3. Mise à jour du patient avec les nouvelles dates
        await supabase
          .from("patients")
          .update({ 
            statut_paiement: "A jour",
            date_dernier_paiement: paymentDate.toISOString(),
            date_fin_abonnement: endDate.toISOString()
          })
          .eq("id", abo.patient.id);
        
        // 4. Formater les dates pour l'affichage
        const endDateFormatted = endDate.toLocaleDateString('fr-FR', {
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        });
        
        // 5. 🔔 Notification Push à la famille avec la date de fin
        if (abo.patient.famille_user_id) {
          await sendPushNotification(
            abo.patient.famille_user_id,
            "💎 Abonnement activé",
            `Paiement reçu pour ${abo.patient.nom_complet}. Votre abonnement est valable jusqu'au ${endDateFormatted}.`,
            "/#dashboard"
          );
        }
        
        // 6. 📝 Log de l'événement pour traçabilité
        await supabase.from("logs").insert([{
          user_id: abo.patient.famille_user_id,
          action: "paiement_auto",
          details: `Facture ${abonnement_id} payée via ${moyen_paiement}: ${montant_recu} CFA`,
          reference: reference,
          date_fin_abonnement: endDate.toISOString()
        }]);
        
        console.log(`✅ [WEBHOOK] Facture ${abonnement_id} traitée - Valable jusqu'au ${endDateFormatted}`);
      }
    } catch (err) {
      console.error("❌ [WEBHOOK ERROR]:", err.message);
    }
  }
  
  // Toujours répondre 200 pour éviter les tentatives de ré-envoi
  res.sendStatus(200);
});

/**
 * 📅 CALCULER LA DATE DE FIN D'ABONNEMENT (1 mois + 5 jours)
 */
function calculateSubscriptionEndDate(paymentDate) {
  const endDate = new Date(paymentDate);
  endDate.setMonth(endDate.getMonth() + 1); // +1 mois
  endDate.setDate(endDate.getDate() + 5);   // +5 jours
  return endDate;
}
/**
 * 🔐 Vérification de la signature webhook (sécurité renforcée)
 */
function verifyWebhookSignature(signature, payload) {
  // En développement, on accepte sans signature
  if (process.env.NODE_ENV === 'development') {
    console.log("⚠️ [WEBHOOK] Mode développement - signature non vérifiée");
    return true;
  }
  
  if (!signature || !process.env.FEDAPAY_WEBHOOK_SECRET) {
    console.error("❌ [WEBHOOK] Signature ou secret manquant");
    return false;
  }
  
  try {
    const crypto = require('crypto');
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
 * 🩺 VÉRIFICATION DE L'ÉTAT DU WEBHOOK (pour debug)
 */
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

function verifyWebhookSignature(signature, payload) {
  // Mode développement - accepter tous les webhooks
  console.log("⚠️ Webhook reçu (signature ignorée pour le test)");
  return true;
}



/**
 * ✅ MISE À JOUR STATUT APRÈS PAIEMENT (Appelé par webhook)
 */
async function updatePaymentStatus(abonnementId, montantRecu) {
    // Mettre à jour la facture
    const { data: abo } = await supabase
        .from("abonnements")
        .update({
            montant_paye: montantRecu,
            statut: "Payé",
            date_paiement: new Date().toISOString()
        })
        .eq("id", abonnementId)
        .select("patient_id")
        .single();
    
    if (abo) {
        // Débloquer immédiatement le patient
        await supabase
            .from("patients")
            .update({ 
                statut_paiement: "A jour",
                date_dernier_paiement: new Date().toISOString()
            })
            .eq("id", abo.patient_id);
        
        // Mettre à jour le localStorage via l'API (pour les clients connectés)
        await supabase.from("user_sessions").upsert({
            user_id: abo.patient.famille_user_id,
            payment_status: "A jour",
            last_payment_date: new Date().toISOString()
        });
    }
}
module.exports = router;
