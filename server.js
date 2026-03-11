// ============================================
// server.js - Laboratório
// ============================================
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================
// Conexão MongoDB (mesma base do ministério)
// ============================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sns';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.log('❌ Erro MongoDB:', err));

// ============================================
// Middlewares
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // arquivos estáticos

// ============================================
// Modelos (mesmos do ministério, simplificados)
// ============================================
const laboratorioSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  nif: { type: String, required: true, unique: true },
  tipo: { type: String, enum: ['laboratorio', 'hospital', 'clinica'] },
  provincia: String,
  endereco: String,
  email: String,
  telefone: String,
  diretor: String,
  apiKey: { type: String, unique: true },
  ativo: { type: Boolean, default: true },
  totalEmissoes: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Laboratorio = mongoose.model('Laboratorio', laboratorioSchema);

const certificateSchema = new mongoose.Schema({
  numero: { type: String, unique: true },
  tipo: { type: Number, required: true, enum: [1,2,3,4,5,6,7,8] },
  paciente: {
    nomeCompleto: { type: String, required: true },
    genero: { type: String, enum: ['M', 'F'] },
    dataNascimento: Date,
    bi: String
  },
  laborantin: {
    nome: String,
    registro: String
  },
  dados: mongoose.Schema.Types.Mixed,
  hash: { type: String, unique: true },
  emitidoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Laboratorio' },
  emitidoEm: { type: Date, default: Date.now }
});
const Certificate = mongoose.model('Certificate', certificateSchema);

// ============================================
// Funções auxiliares
// ============================================
function gerarApiKey() {
  return 'LAB-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function gerarNumeroCertificado(tipo) {
  const ano = new Date().getFullYear();
  const mes = (new Date().getMonth() + 1).toString().padStart(2, '0');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return 'CERT-' + tipo + '-' + ano + mes + '-' + random;
}

// Middleware de autenticação por API Key
const authLaboratorio = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ erro: 'API Key não fornecida' });

  const lab = await Laboratorio.findOne({ apiKey, ativo: true });
  if (!lab) return res.status(401).json({ erro: 'API Key inválida' });

  req.lab = lab;
  next();
};

// ============================================
// Rotas Públicas (HTML)
// ============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/novo-certificado', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'novo-certificado.html'));
});

// ============================================
// API de Login
// ============================================
app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave API não fornecida' });

    const lab = await Laboratorio.findOne({ apiKey, ativo: true });
    if (!lab) return res.status(401).json({ erro: 'Chave API inválida' });

    const token = jwt.sign(
      { id: lab._id, nome: lab.nome },
      process.env.JWT_SECRET || 'secret-key',
      { expiresIn: '7d' }
    );

    res.json({ token, lab: { nome: lab.nome, totalEmissoes: lab.totalEmissoes } });
  } catch (error) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ============================================
// Rotas Protegidas
// ============================================
app.get('/api/laboratorio/me', authLaboratorio, (req, res) => {
  res.json(req.lab);
});

app.get('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const certs = await Certificate.find({ emitidoPor: req.lab._id }).sort({ emitidoEm: -1 });
    res.json(certs);
  } catch (error) {
    res.status(500).json({ erro: 'Erro ao listar certificados' });
  }
});

app.post('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const { tipo, paciente, laborantin, dados } = req.body;
    if (!tipo || !paciente || !paciente.nomeCompleto) {
      return res.status(400).json({ erro: 'Dados incompletos' });
    }

    const numero = gerarNumeroCertificado(tipo);
    const hash = crypto.createHash('sha256').update(numero + Date.now()).digest('hex');

    const certificado = new Certificate({
      numero,
      tipo,
      paciente,
      laborantin,
      dados,
      hash,
      emitidoPor: req.lab._id
    });
    await certificado.save();

    req.lab.totalEmissoes++;
    await req.lab.save();

    res.json({ success: true, numero });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/laboratorio/certificados/pdf', authLaboratorio, async (req, res) => {
  try {
    const { numero } = req.body;
    if (!numero) return res.status(400).json({ erro: 'Número não fornecido' });

    const certificado = await Certificate.findOne({ numero, emitidoPor: req.lab._id });
    if (!certificado) return res.status(404).json({ erro: 'Certificado não encontrado' });

    const lab = req.lab;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${numero}.pdf`);
    doc.pipe(res);

    // Cabeçalho
    doc.fillColor('#006633');
    doc.fontSize(20).text('REPÚBLICA DE ANGOLA', 0, 50, { align: 'center' });
    doc.fontSize(16).text('MINISTÉRIO DA SAÚDE', 0, 80, { align: 'center' });
    doc.fontSize(24).text('SISTEMA NACIONAL DE SAÚDE', 0, 110, { align: 'center' });
    doc.strokeColor('#006633').lineWidth(2)
      .moveTo(doc.page.width / 2 - 250, 150)
      .lineTo(doc.page.width / 2 + 250, 150)
      .stroke();
    let y = 180;

    // Laboratório
    doc.fontSize(14).text(lab.nome, 50, y);
    doc.fontSize(10).fillColor('#666').text(`NIF: ${lab.nif} | ${lab.provincia || ''}`, 50, y + 20);
    doc.text(`Endereço: ${lab.endereco || ''} | Tel: ${lab.telefone || ''}`, 50, y + 35);
    y += 60;

    // Certificado
    doc.fillColor('#006633').fontSize(12).text(`CERTIFICADO Nº: ${numero}`, 50, y);
    doc.fontSize(10).fillColor('#666').text(`Emissão: ${new Date().toLocaleDateString('pt-PT')}`, 50, y + 15);
    y += 40;

    // Paciente
    doc.fillColor('#006633').text('PACIENTE:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificado.paciente.nomeCompleto}`, 70, y);
    y += 15;
    if (certificado.paciente.bi) {
      doc.text(`BI: ${certificado.paciente.bi}`, 70, y);
      y += 15;
    }

    // Resultados
    doc.fillColor('#006633').fontSize(12).text('RESULTADOS:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(10);
    for (let [chave, valor] of Object.entries(certificado.dados || {})) {
      doc.text(`${chave}: ${valor}`, 70, y);
      y += 15;
      if (y > 700) { doc.addPage(); y = 50; }
    }

    // QR Code
    const qrData = `${numero}|${lab.nome}|${certificado.paciente.nomeCompleto}`;
    const qrBuffer = await QRCode.toBuffer(qrData, { width: 100 });
    doc.image(qrBuffer, 450, 650, { width: 100 });

    doc.end();
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================
// Iniciar servidor
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Laboratório rodando na porta ${PORT}`);
});