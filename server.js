require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // Changé pour bcryptjs
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cors = require('cors'); // Ajout de CORS

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'segredo-laboratorio-muito-seguro';
const saltRounds = 10;

// Middlewares
app.use(cors()); // Autorise les requêtes depuis ton front-end
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/certificados', express.static(path.join(__dirname, 'certificados')));

// MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Erro no MongoDB:', err));

const certDir = path.join(__dirname, 'certificados');
if (!fs.existsSync(certDir)) { fs.mkdirSync(certDir, { recursive: true }); }

// ============================================
// MODELOS
// ============================================

const PROVINCIAS = ['Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango', 'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla', 'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico', 'Namibe', 'Uíge', 'Zaire'];

const establishmentSchema = new mongoose.Schema({
  establishmentType: { type: String, enum: ['laboratorio', 'hospital', 'empresa', 'ong'], required: true },
  name: { type: String, required: true },
  nif: { type: String, required: true, unique: true },
  keyId: { type: String, required: true, unique: true }, // Pour recherche rapide
  keyHash: { type: String, required: true },
  licenseValidity: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  director: String,
  email: String,
  address: String,
  municipality: String,
  province: String
}, { timestamps: true });

const Establishment = mongoose.model('Establishment', establishmentSchema);

const laborantinSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment' },
  name: String,
  email: { type: String, unique: true },
  passwordHash: String,
  role: { type: String, enum: ['responsable', 'laborantin'], default: 'laborantin' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

const Laborantin = mongoose.model('Laborantin', laborantinSchema);

const certificateSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Laborantin' },
  certificateNumber: { type: String, unique: true },
  patientName: String,
  patientId: String,
  diseaseCategory: String,
  diagnosis: String,
  testDate: Date,
  pdfPath: String
}, { timestamps: true });

const Certificate = mongoose.model('Certificate', certificateSchema);

// ============================================
// ROUTES & MIDDLEWARE
// ============================================

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Acesso negado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) { res.status(401).json({ erro: 'Token inválido' }); }
}

// Login Optimisé (Recherche par KeyId)
app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    const parts = apiKey.split('-');
    if (parts.length < 3) return res.status(400).json({ erro: 'Formato inválido' });

    const keyId = `${parts[0]}-${parts[1]}`;
    const est = await Establishment.findOne({ keyId });

    if (!est || !(await bcrypt.compare(apiKey, est.keyHash))) {
      return res.status(401).json({ erro: 'Chave inválida' });
    }

    let resp = await Laborantin.findOne({ establishmentId: est._id, role: 'responsable' });
    let tempPass = null;

    if (!resp) {
      tempPass = crypto.randomBytes(4).toString('hex');
      resp = new Laborantin({
        establishmentId: est._id,
        name: est.director,
        email: est.email,
        passwordHash: await bcrypt.hash(tempPass, saltRounds),
        role: 'responsable'
      });
      await resp.save();
    }

    const token = jwt.sign({ id: resp._id, establishmentId: est._id, role: resp.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: resp.role, establishmentId: est._id, tempPassword: tempPass });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/laboratorio/establishment', authMiddleware, async (req, res) => {
  const est = await Establishment.findById(req.user.establishmentId);
  res.json(est);
});

app.get('/api/laboratorio/certificates', authMiddleware, async (req, res) => {
  const certs = await Certificate.find({ establishmentId: req.user.establishmentId }).sort('-createdAt');
  res.json(certs);
});

// Création Certificat + PDF
app.post('/api/laboratorio/certificates', authMiddleware, async (req, res) => {
  try {
    const cert = new Certificate({
      ...req.body,
      establishmentId: req.user.establishmentId,
      createdBy: req.user.id,
      certificateNumber: `CERT-${Date.now()}`
    });
    
    // Simplicité : Génération PDF ici ou appel fonction
    cert.pdfPath = `cert_${cert.certificateNumber}.pdf`;
    await cert.save();
    res.json(cert);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Route de téléchargement sécurisée
app.get('/api/laboratorio/certificates/:id/pdf', authMiddleware, async (req, res) => {
    const cert = await Certificate.findById(req.params.id);
    if (!cert) return res.status(404).send('Não encontrado');
    const filePath = path.join(certDir, cert.pdfPath);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('Arquivo PDF não gerado');
    }
});

app.listen(PORT, () => console.log(`🚀 Porta: ${PORT}`));
