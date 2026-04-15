const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification, getDurationFromPack, calculateSubscriptionEndDate } = require("../utils");
const { createNotification } = require("./notifications");

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
        await sendPushNotification(
          abo.patient.famille_user_id,
          "✅ Paiement validé",
          `Le paiement de ${montant} CFA pour ${abo.patient.nom_complet} a été reçu.`,
          "/#billing"
        );
        
        await createNotification(
          abo.patient.famille_user_id,
          "💳 Paiement reçu",
          `Votre paiement de ${montant} CFA a été confirmé pour ${abo.patient.nom_complet}.`,
          "payment",
          "/#billing"
        );
      }
    }

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur paiement manuel:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 💳 3. INITIER UN PAIEMENT (NOUVEAU - PLUS COMPLET)
// ============================================================
router.post("/initiate-payment", middleware(["FAMILLE"]), async (req, res) => {
  const { pack_id, duration_months, patient_id, amount } = req.body;
  
  console.log("🔵 Initiation paiement:", { pack_id, duration_months, patient_id, amount });
  
  if (!process.env.FEDAPAY_SECRET_KEY) {
    console.error("❌ FEDAPAY_SECRET_KEY manquante");
    return res.status(500).json({ error: "Configuration FedaPay manquante" });
  }

  try {
    // Récupérer les infos du patient
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("id, nom_complet, formule, famille_user_id")
      .eq("id", patient_id)
      .single();
    
    if (patientErr) throw patientErr;
    
    // Récupérer l'utilisateur pour l'email
    const { data: user, error: userErr } = await supabase
      .from("profiles")
      .select("email, nom")
      .eq("id", req.user.userId)
      .single();
    
    if (userErr) throw userErr;
    
    const fedapayMode = process.env.FEDAPAY_MODE || 'sandbox';
    const apiUrl = fedapayMode === 'production' 
      ? "https://api.fedapay.com/v1/transactions"
      : "https://sandbox-api.fedapay.com/v1/transactions";
    
    console.log(`🌍 Mode FedaPay: ${fedapayMode}`);
    
    const response = await axios.post(
      apiUrl,
      {
        amount: Math.round(amount),
        currency: "XOF",
        description: `Pack ${patient.formule || pack_id} - ${duration_months} mois`,
        customer: {
          email: user.email,
          firstname: user.nom?.split(' ')[0] || '',
          lastname: user.nom?.split(' ')[1] || ''
        },
        callback_url: "https://stevenckohr-pixel.github.io/sante-plus-frontend/#billing?status=success",
        cancel_url: "https://stevenckohr-pixel.github.io/sante-plus-frontend/#billing?status=cancel",
        metadata: {
          patient_id: patient_id,
          user_id: req.user.userId,
          duration_months: duration_months,
          pack_name: patient.formule || pack_id
        }
      },
      {
        headers: { 
          Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );
    
    if (!response.data || !response.data.payment_url) {
      throw new Error("La réponse de FedaPay ne contient pas d'URL");
    }
    
    // Stocker la transaction en attente
    const { error: insertErr } = await supabase
      .from("pending_transactions")
      .insert([{
        user_id: req.user.userId,
        patient_id: patient_id,
        transaction_id: response.data.id,
        amount: amount,
        duration_months: duration_months,
        pack_name: patient.formule || pack_id,
        status: "PENDING",
        created_at: new Date()
      }]);
    
    if (insertErr) console.warn("⚠️ Erreur stockage transaction:", insertErr.message);
    
    console.log("✅ Transaction créée:", response.data.id);
    res.json({ 
      success: true, 
      transaction_id: response.data.id,
      payment_url: response.data.payment_url 
    });
    
  } catch (err) {
    console.error("❌ FedaPay Error:", err.response?.data || err.message);
    let errorMessage = "Impossible d'initier le paiement";
    if (err.response?.status === 401) {
      errorMessage = "Clé API FedaPay invalide";
    } else if (err.response?.data?.errors) {
      errorMessage = err.response.data.errors.map(e => e.message).join(", ");
    }
    res.status(500).json({ error: errorMessage });
  }
});

// ============================================================
// 💳 4. GÉNÉRER UN LIEN FEDAPAY CHECKOUT (GARDE POUR COMPATIBILITÉ)
// ============================================================
router.post("/generate-payment", middleware(["FAMILLE"]), async (req, res) => {
  const { abonnement_id, montant, email_client } = req.body;
  
  console.log("🔵 Génération paiement Checkout:", { abonnement_id, montant, email_client });
  
  if (!process.env.FEDAPAY_SECRET_KEY) {
    console.error("❌ FEDAPAY_SECRET_KEY manquante");
    return res.status(500).json({ error: "Configuration FedaPay manquante" });
  }

  const fedapayMode = process.env.FEDAPAY_MODE || 'sandbox';
  const apiUrl = fedapayMode === 'production' 
    ? "https://api.fedapay.com/v1/checkouts"
    : "https://sandbox-api.fedapay.com/v1/checkouts";

  try {
    const response = await axios.post(
      apiUrl,
      {
        amount: montant,
        currency: "XOF",
        description: `Santé Plus - Abonnement`,
        customer_email: email_client || "client@santeplus.bj",
        callback_url: "https://stevenckohr-pixel.github.io/sante-plus-frontend/#billing?status=success",
        metadata: { abonnement_id: abonnement_id }
      },
      {
        headers: { 
          Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );
    
    if (!response.data || !response.data.url) {
      throw new Error("La réponse de FedaPay ne contient pas d'URL");
    }
    
    res.json({ url: response.data.url });
    
  } catch (err) {
    console.error("❌ FedaPay Error:", err.response?.data || err.message);
    let errorMessage = "Impossible de générer le lien de paiement";
    if (err.response?.status === 401) errorMessage = "Clé API FedaPay invalide";
    else if (err.response?.data?.errors) errorMessage = err.response.data.errors.map(e => e.message).join(", ");
    res.status(500).json({ error: errorMessage });
  }
});

// ============================================================
// 🔔 5. WEBHOOK FEDAPAY
// ============================================================
router.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("💰 [WEBHOOK] Signal reçu");
  
  // Si le body est un buffer, le parser
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (e) {
    event = req.body;
  }
  
  const signature = req.headers['x-fedapay-signature'];
  
  if (!verifyWebhookSignature(signature, JSON.stringify(event))) {
    console.error("❌ [WEBHOOK] Signature invalide");
    return res.status(401).json({ error: "Signature invalide" });
  }
  
  // Traitement du paiement approuvé
  if (event.type === 'transaction.approved' || event.type === 'checkout.completed') {
    const transaction = event.data || event.entity;
    const transactionId = transaction.id;
    const amount = transaction.amount;
    const metadata = transaction.metadata || {};
    
    console.log(`✅ Paiement confirmé: ${transactionId} - ${amount} FCFA`);
    
    try {
      // Récupérer la transaction en attente
      const { data: pending, error: pendingErr } = await supabase
        .from("pending_transactions")
        .select("*")
        .eq("transaction_id", transactionId)
        .single();
      
      if (pendingErr && pendingErr.code !== 'PGRST116') {
        console.error("Erreur recherche transaction:", pendingErr);
      }
      
      const patientId = metadata.patient_id || pending?.patient_id;
      const durationMonths = metadata.duration_months || pending?.duration_months || 1;
      const userId = metadata.user_id || pending?.user_id;
      const packName = metadata.pack_name || pending?.pack_name || 'Standard';
      
      if (!patientId) {
        console.error("❌ Pas de patient_id dans la transaction");
        return res.sendStatus(200);
      }
      
      const paymentDate = new Date();
      const endDate = calculateSubscriptionEndDate(paymentDate, durationMonths, 5);
      const monthYear = paymentDate.toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" });
      
      // Créer l'abonnement
      const { data: abo, error: aboErr } = await supabase
        .from("abonnements")
        .insert([{
          patient_id: patientId,
          mois_annee: monthYear,
          montant_du: amount,
          montant_paye: amount,
          statut: "Payé",
          type_pack: packName,
          date_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          duree_mois: durationMonths,
          reference_paiement: transactionId,
          mode_paiement: "FEDAPAY"
        }])
        .select()
        .single();
      
      if (aboErr) throw aboErr;
      
      // Mettre à jour le patient
      await supabase
        .from("patients")
        .update({ 
          statut_paiement: "A jour",
          date_dernier_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          duree_abonnement_mois: durationMonths
        })
        .eq("id", patientId);
      
      // Mettre à jour la transaction en attente
      if (pending?.id) {
        await supabase
          .from("pending_transactions")
          .update({ status: "COMPLETED", abonnement_id: abo.id })
          .eq("id", pending.id);
      }
      
      // Récupérer la famille pour notification
      const { data: patient } = await supabase
        .from("patients")
        .select("famille_user_id, nom_complet")
        .eq("id", patientId)
        .single();
      
      if (patient?.famille_user_id) {
        const endDateFormatted = endDate.toLocaleDateString('fr-FR');
        
        await sendPushNotification(
          patient.famille_user_id,
          "💎 Abonnement activé",
          `Paiement reçu pour ${patient.nom_complet}. Valable ${durationMonths} mois jusqu'au ${endDateFormatted}.`,
          "/#dashboard"
        );

        await createNotification(
          patient.famille_user_id,
          "💎 Abonnement activé",
          `Votre abonnement pour ${patient.nom_complet} est actif jusqu'au ${endDateFormatted}.`,
          "payment",
          "/#dashboard"
        );
      }
      
      console.log(`✅ Abonnement ${durationMonths} mois créé - Valable jusqu'au ${endDate.toLocaleDateString('fr-FR')}`);
      
    } catch (err) {
      console.error("❌ [WEBHOOK ERROR]:", err.message);
    }
  }
  
  res.sendStatus(200);
});

// ============================================================
// 🔐 Vérification de la signature webhook
// ============================================================
function verifyWebhookSignature(signature, payload) {
  if (!signature || !process.env.FEDAPAY_WEBHOOK_SECRET) {
    console.error("❌ Signature ou secret manquant");
    return false;
  }
  
  try {
    const parts = signature.split(',');
    let timestamp = null;
    let signatureHash = null;
    
    for (const part of parts) {
      if (part.startsWith('t=')) timestamp = part.substring(2);
      else if (part.startsWith('s=')) signatureHash = part.substring(2);
    }
    
    if (!timestamp || !signatureHash) {
      console.error("❌ Format signature invalide");
      return false;
    }
    
    const signedPayload = timestamp + "." + payload;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.FEDAPAY_WEBHOOK_SECRET)
      .update(signedPayload)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signatureHash, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
    
  } catch (err) {
    console.error("❌ Erreur vérification signature:", err.message);
    return false;
  }
}

// ============================================================
// 🩺 6. VÉRIFICATION DE L'ÉTAT DU WEBHOOK (Debug)
// ============================================================
router.get("/webhook/status", middleware(["COORDINATEUR"]), async (req, res) => {
  const webhookUrl = `${process.env.API_URL || 'https://sante-plus-backend-ux1n.onrender.com'}/api/billing/webhook`;
  
  res.json({
    status: "active",
    webhook_url: webhookUrl,
    secret_configured: !!process.env.FEDAPAY_WEBHOOK_SECRET,
    environment: process.env.NODE_ENV || 'production'
  });
});

// ============================================================
// 📝 7. GÉNÉRER UNE FACTURE
// ============================================================
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

// ============================================================
// 📊 8. RÉCUPÉRER LES TRANSACTIONS EN ATTENTE
// ============================================================
router.get("/pending-transactions", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
  try {
    let query = supabase.from("pending_transactions").select("*");
    
    if (req.user.role === "FAMILLE") {
      query = query.eq("user_id", req.user.userId);
    }
    
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
