const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const axios = require("axios");

// Configuration Kikiapay
const KIKIAPAY_CONFIG = {
    sandbox: true,
    api_key: "b2854970ebcc11efb68863f84d1e6b32",
    api_secret: "tpk_b2857080ebcc11efb68863f84d1e6b32"
};

// ============================================================
// 1. INITIER UN PAIEMENT
// ============================================================
router.post("/init-payment", async (req, res) => {
    const { abonnement_id, montant, patient_nom, user_email } = req.body;

    if (!abonnement_id || !montant) {
        return res.status(400).json({ error: "abonnement_id et montant requis" });
    }

    try {
        // Générer un ID de transaction unique
        const transaction_id = `SPS_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        // Créer une transaction temporaire dans la BDD
        const { error: insertError } = await supabase
            .from("pending_transactions")
            .insert([{
                transaction_id: transaction_id,
                abonnement_id: abonnement_id,
                montant: montant,
                statut: "PENDING",
                created_at: new Date()
            }]);

        if (insertError) throw insertError;

        // Appel API Kikiapay pour créer la transaction
        const apiUrl = KIKIAPAY_CONFIG.sandbox 
            ? "https://sandbox.kikiapay.net/api/v1/transaction"
            : "https://api.kikiapay.net/api/v1/transaction";

        const response = await axios.post(apiUrl, {
            amount: montant,
            currency: "XOF",
            first_name: patient_nom?.split(' ')[0] || "Client",
            last_name: patient_nom?.split(' ')[1] || "SPS",
            email: user_email || "client@sps.bj",
            phone: "",
            description: `Paiement abonnement Santé Plus`,
            redirect_url: `${process.env.FRONTEND_URL || 'https://stevenckohr-pixel.github.io/sante-plus-frontend'}/#billing?status=success`,
            cancel_url: `${process.env.FRONTEND_URL || 'https://stevenckohr-pixel.github.io/sante-plus-frontend'}/#billing?status=cancel`,
            metadata: {
                transaction_id: transaction_id,
                abonnement_id: abonnement_id
            }
        }, {
            headers: {
                "X-Api-Key": KIKIAPAY_CONFIG.api_key,
                "Content-Type": "application/json"
            }
        });

        console.log("✅ Transaction Kikiapay créée:", response.data);

        // Retourner l'URL de paiement
        res.json({
            success: true,
            payment_url: response.data.payment_url || response.data.redirect_url,
            transaction_id: transaction_id
        });

    } catch (err) {
        console.error("❌ Erreur init paiement:", err.response?.data || err.message);
        res.status(500).json({ 
            error: err.response?.data?.message || "Erreur d'initialisation" 
        });
    }
});

// ============================================================
// 2. CONFIRMATION DE PAIEMENT (appelée après redirection)
// ============================================================
router.get("/confirm", async (req, res) => {
    const { transaction_id, status, payment_id } = req.query;

    console.log("🔔 Confirmation paiement reçue:", { transaction_id, status, payment_id });

    if (!transaction_id) {
        return res.redirect(`${process.env.FRONTEND_URL || 'https://stevenckohr-pixel.github.io/sante-plus-frontend'}/#billing?status=error`);
    }

    try {
        if (status === "success" || status === "SUCCESS") {
            // Récupérer la transaction en attente
            const { data: pending, error: pendingErr } = await supabase
                .from("pending_transactions")
                .select("*")
                .eq("transaction_id", transaction_id)
                .single();

            if (pendingErr || !pending) {
                console.error("❌ Transaction non trouvée:", transaction_id);
                return res.redirect(`${process.env.FRONTEND_URL}/#billing?status=error`);
            }

            // Mettre à jour l'abonnement
            const { error: aboErr } = await supabase
                .from("abonnements")
                .update({
                    statut: "Payé",
                    date_paiement: new Date().toISOString(),
                    montant_paye: pending.montant,
                    reference_paiement: payment_id || transaction_id,
                    mode_paiement: "KIKIAPAY"
                })
                .eq("id", pending.abonnement_id);

            if (aboErr) throw aboErr;

            // Mettre à jour le patient
            const { data: abo } = await supabase
                .from("abonnements")
                .select("patient_id")
                .eq("id", pending.abonnement_id)
                .single();

            if (abo) {
                await supabase
                    .from("patients")
                    .update({
                        statut_paiement: "A jour",
                        date_dernier_paiement: new Date().toISOString()
                    })
                    .eq("id", abo.patient_id);
            }

            // Mettre à jour la transaction en attente
            await supabase
                .from("pending_transactions")
                .update({ statut: "COMPLETED" })
                .eq("transaction_id", transaction_id);

            console.log(`✅ Paiement validé pour transaction ${transaction_id}`);

            // Rediriger vers la page de succès
            res.redirect(`${process.env.FRONTEND_URL}/#billing?status=success`);

        } else {
            // Paiement échoué ou annulé
            await supabase
                .from("pending_transactions")
                .update({ statut: "FAILED" })
                .eq("transaction_id", transaction_id);

            res.redirect(`${process.env.FRONTEND_URL}/#billing?status=cancel`);
        }

    } catch (err) {
        console.error("❌ Erreur confirmation:", err.message);
        res.redirect(`${process.env.FRONTEND_URL}/#billing?status=error`);
    }
});

// ============================================================
// 3. ANNULATION PAIEMENT
// ============================================================
router.get("/cancel", async (req, res) => {
    console.log("❌ Paiement annulé:", req.query);
    res.redirect(`${process.env.FRONTEND_URL || 'https://stevenckohr-pixel.github.io/sante-plus-frontend'}/#billing?status=cancel`);
});

module.exports = router;
