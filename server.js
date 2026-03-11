// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'segredo-laboratorio-muito-seguro';
const saltRounds = 12;

// ============================================
// CONEXÃO MONGODB (mesma base do ministério)
// ============================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sns';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.log('❌ Erro no MongoDB:', err));

// Criar pasta para certificados se não existir
const certDir = path.join(__dirname, 'certificados');
if (!fs.existsSync(certDir)) {
  fs.mkdirSync(certDir, { recursive: true });
}

// ============================================
// MODELOS (compartilhados com o ministério)
// ============================================

// Lista das 18 províncias de Angola
const PROVINCIAS = [
  'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango',
  'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla',
  'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico',
  'Namibe', 'Uíge', 'Zaire'
];

// Schema de Estabelecimento (idêntico ao do ministério)
const establishmentSchema = new mongoose.Schema({
  establishmentType: {
    type: String,
    enum: ['laboratorio', 'hospital', 'empresa', 'ong'],
    required: true
  },
  name: { type: String, required: true, trim: true },
  nif: { type: String, required: true, unique: true, trim: true },
  institutionType: {
    type: String,
    enum: ['Público', 'Privado'],
    required: true
  },
  province: { type: String, required: true, enum: PROVINCIAS },
  municipality: { type: String, required: true, trim: true },
  address: { type: String, required: true, trim: true },
  phone1: { type: String, required: true, trim: true },
  phone2: { type: String, trim: true },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Email inválido']
  },
  director: { type: String, required: true, trim: true },
  technicalResponsible: { type: String, required: true, trim: true },
  licenseNumber: { type: String, required: true, trim: true },
  licenseValidity: { type: Date, required: true },
  keyHash: { type: String, required: true, unique: true },
  keyPrefix: { type: String, default: 'SNS-' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true, toJSON: { virtuals: true } });

establishmentSchema.virtual('status').get(function() {
  if (!this.isActive) return 'Inativo';
  return this.licenseValidity < new Date() ? 'Inativo' : 'Ativo';
});

const Establishment = mongoose.model('Establishment', establishmentSchema);

// Schema de Certificado
const certificateSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Laborantin', required: true },
  certificateNumber: { type: String, required: true, unique: true },
  patientName: { type: String, required: true },
  patientId: { type: String },
  patientBirthDate: { type: Date },
  diseaseCategory: { type: String, required: true },
  diagnosis: { type: String, required: true },
  testDate: { type: Date, default: Date.now },
  testResults: { type: mongoose.Schema.Types.Mixed },
  pdfPath: { type: String }
}, { timestamps: true });

// Gerar número de certificado único antes de salvar
certificateSchema.pre('save', async function(next) {
  if (!this.certificateNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const count = await mongoose.model('Certificate').countDocuments();
    this.certificateNumber = `CERT-${year}${month}-${(count + 1).toString().padStart(6, '0')}`;
  }
  next();
});

const Certificate = mongoose.model('Certificate', certificateSchema);

// Schema de Laborantin (utilizadores internos do laboratório)
const laborantinSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['responsable', 'laborantin'], default: 'laborantin' },
  isActive: { type: Boolean, default: true },
  lastLogin: { type: Date }
}, { timestamps: true });

laborantinSchema.methods.verifyPassword = async function(password) {
  return await bcrypt.compare(password, this.passwordHash);
};

const Laborantin = mongoose.model('Laborantin', laborantinSchema);

// ============================================
// MIDDLEWARES
// ============================================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/certificados', express.static(path.join(__dirname, 'certificados')));

// Rota explícita para a raiz (garantia)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware de autenticação JWT
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
}

// ============================================
// ROTAS PÚBLICAS
// ============================================

// Login com chave API
app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave API não fornecida' });

    const prefix = apiKey.split('-')[0];
    if (prefix !== 'LAB') {
      return res.status(403).json({ erro: 'Esta chave não é válida para laboratórios' });
    }

    const establishments = await Establishment.find({ establishmentType: 'laboratorio' }).select('+keyHash');
    let establishment = null;
    for (const est of establishments) {
      if (await bcrypt.compare(apiKey, est.keyHash)) {
        establishment = est;
        break;
      }
    }

    if (!establishment) {
      return res.status(401).json({ erro: 'Chave API inválida' });
    }

    if (establishment.status === 'Inativo') {
      return res.status(403).json({ erro: 'Estabelecimento inativo. Contacte o ministério.' });
    }

    let responsable = await Laborantin.findOne({ establishmentId: establishment._id, role: 'responsable' });

    if (!responsable) {
      const tempPassword = crypto.randomBytes(4).toString('hex');
      const passwordHash = await bcrypt.hash(tempPassword, saltRounds);
      responsable = new Laborantin({
        establishmentId: establishment._id,
        name: establishment.director,
        email: establishment.email || `${establishment.name.replace(/\s+/g, '_')}@temp.ao`,
        passwordHash,
        role: 'responsable',
        isActive: true
      });
      await responsable.save();

      const token = jwt.sign(
        { id: responsable._id, role: 'responsable', establishmentId: establishment._id },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.json({
        token,
        role: 'responsable',
        establishmentId: establishment._id,
        tempPassword,
        message: 'Conta de responsável criada. Guarde a senha temporária.'
      });
    }

    const token = jwt.sign(
      { id: responsable._id, role: responsable.role, establishmentId: establishment._id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, role: responsable.role, establishmentId: establishment._id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// Login com email e senha (para responsáveis e laborantins)
app.post('/api/laboratorio/login-email', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    const laborantin = await Laborantin.findOne({ email });
    if (!laborantin || !laborantin.isActive) {
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }

    const valid = await laborantin.verifyPassword(password);
    if (!valid) return res.status(401).json({ erro: 'Credenciais inválidas' });

    laborantin.lastLogin = new Date();
    await laborantin.save();

    const token = jwt.sign(
      { id: laborantin._id, role: laborantin.role, establishmentId: laborantin.establishmentId },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, role: laborantin.role, establishmentId: laborantin.establishmentId });
  } catch (error) {
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// ============================================
// ROTAS PROTEGIDAS
// ============================================

// Obter informações do estabelecimento logado
app.get('/api/laboratorio/establishment', authMiddleware, async (req, res) => {
  try {
    const establishment = await Establishment.findById(req.user.establishmentId).select('-keyHash');
    if (!establishment) return res.status(404).json({ erro: 'Estabelecimento não encontrado' });
    res.json(establishment);
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Listar certificados do laboratório
app.get('/api/laboratorio/certificates', authMiddleware, async (req, res) => {
  try {
    const certificates = await Certificate.find({ establishmentId: req.user.establishmentId })
      .sort('-createdAt')
      .populate('createdBy', 'name');
    res.json(certificates);
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Função para gerar PDF do certificado
async function generateCertificatePDF(certificate, establishment, laborantin) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      // Cabeçalho do Ministério
      doc.rect(50, 30, 500, 5).fill('#005a9c');
      doc.fontSize(24)
         .font('Helvetica-Bold')
         .fillColor('#005a9c')
         .text('REPÚBLICA DE ANGOLA', 50, 60, { align: 'center' });
      doc.fontSize(18)
         .text('MINISTÉRIO DA SAÚDE', { align: 'center' })
         .text('SISTEMA NACIONAL DE SAÚDE', { align: 'center' })
         .moveDown(2);
      doc.strokeColor('#005a9c')
         .lineWidth(1)
         .moveTo(50, doc.y)
         .lineTo(550, doc.y)
         .stroke()
         .moveDown(2);

      // Título
      doc.fontSize(20)
         .font('Helvetica-Bold')
         .fillColor('#1f2937')
         .text('CERTIFICADO DE ANÁLISE LABORATORIAL', { align: 'center' })
         .moveDown(2);

      // Informações do estabelecimento
      doc.fontSize(12).font('Helvetica-Bold').text('LABORATÓRIO:');
      doc.font('Helvetica').text(establishment.name);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('NIF:');
      doc.font('Helvetica').text(establishment.nif);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('ENDEREÇO:');
      doc.font('Helvetica').text(`${establishment.address}, ${establishment.municipality}, ${establishment.province}`);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('DIRETOR:');
      doc.font('Helvetica').text(establishment.director);
      doc.moveDown(1);

      // Informações do certificado
      doc.font('Helvetica-Bold').text('Nº CERTIFICADO:');
      doc.font('Helvetica').text(certificate.certificateNumber);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('DATA DE EMISSÃO:');
      doc.font('Helvetica').text(new Date(certificate.createdAt).toLocaleDateString('pt-PT'));
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('EMITIDO POR:');
      doc.font('Helvetica').text(laborantin.name);
      doc.moveDown(1);

      // Dados do paciente
      doc.font('Helvetica-Bold').text('PACIENTE:');
      doc.font('Helvetica').text(certificate.patientName);
      doc.moveDown(0.5);
      if (certificate.patientId) {
        doc.font('Helvetica-Bold').text('DOCUMENTO:');
        doc.font('Helvetica').text(certificate.patientId);
        doc.moveDown(0.5);
      }
      if (certificate.patientBirthDate) {
        doc.font('Helvetica-Bold').text('DATA DE NASCIMENTO:');
        doc.font('Helvetica').text(new Date(certificate.patientBirthDate).toLocaleDateString('pt-PT'));
        doc.moveDown(0.5);
      }
      doc.font('Helvetica-Bold').text('CATEGORIA:');
      doc.font('Helvetica').text(certificate.diseaseCategory);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('DIAGNÓSTICO:');
      doc.font('Helvetica').text(certificate.diagnosis);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('DATA DO TESTE:');
      doc.font('Helvetica').text(new Date(certificate.testDate).toLocaleDateString('pt-PT'));
      if (certificate.testResults) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').text('RESULTADOS:');
        doc.font('Helvetica').text(JSON.stringify(certificate.testResults, null, 2));
      }

      // QR Code
      const qrData = JSON.stringify({
        certId: certificate._id,
        number: certificate.certificateNumber,
        lab: establishment.name,
        patient: certificate.patientName
      });
      const qrBuffer = await QRCode.toBuffer(qrData);
      doc.image(qrBuffer, 450, 650, { width: 100, height: 100 });

      // Rodapé
      doc.rect(50, 750, 500, 1).fill('#9ca3af');
      doc.fontSize(8)
         .fillColor('#6b7280')
         .text('Documento oficial gerado eletronicamente. Verifique a autenticidade através do QR Code.', 50, 770, { align: 'center' })
         .text(`Certificado Nº ${certificate.certificateNumber}`, { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// Criar novo certificado
app.post('/api/laboratorio/certificates', authMiddleware, async (req, res) => {
  try {
    const {
      patientName, patientId, patientBirthDate,
      diseaseCategory, diagnosis, testDate, testResults
    } = req.body;

    if (!patientName || !diseaseCategory || !diagnosis) {
      return res.status(400).json({ erro: 'Campos obrigatórios não preenchidos' });
    }

    const establishment = await Establishment.findById(req.user.establishmentId);
    if (!establishment) return res.status(404).json({ erro: 'Estabelecimento não encontrado' });

    const laborantin = await Laborantin.findById(req.user.id);
    if (!laborantin) return res.status(404).json({ erro: 'Utilizador não encontrado' });

    const certificateData = {
      establishmentId: establishment._id,
      createdBy: laborantin._id,
      patientName,
      patientId,
      patientBirthDate: patientBirthDate ? new Date(patientBirthDate) : undefined,
      diseaseCategory,
      diagnosis,
      testDate: testDate ? new Date(testDate) : new Date(),
      testResults
    };

    const certificate = new Certificate(certificateData);
    await certificate.save();

    const pdfBuffer = await generateCertificatePDF(certificate, establishment, laborantin);

    const filename = `certificado_${certificate.certificateNumber}.pdf`;
    const filepath = path.join(certDir, filename);
    fs.writeFileSync(filepath, pdfBuffer);

    certificate.pdfPath = filename;
    await certificate.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: error.message });
  }
});

// Download de certificado existente
app.get('/api/laboratorio/certificates/:id/pdf', authMiddleware, async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id);
    if (!certificate) return res.status(404).json({ erro: 'Certificado não encontrado' });

    if (certificate.establishmentId.toString() !== req.user.establishmentId) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }

    if (!certificate.pdfPath) {
      return res.status(404).json({ erro: 'PDF não disponível' });
    }

    const filepath = path.join(certDir, certificate.pdfPath);
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ erro: 'Arquivo não encontrado' });
    }

    res.sendFile(filepath);
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Listar laborantins do estabelecimento
app.get('/api/laboratorio/laborantins', authMiddleware, async (req, res) => {
  try {
    const laborantins = await Laborantin.find({ establishmentId: req.user.establishmentId }).select('-passwordHash');
    res.json(laborantins);
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Criar laborantin (apenas responsável)
app.post('/api/laboratorio/laborantins', authMiddleware, async (req, res) => {
  if (req.user.role !== 'responsable') {
    return res.status(403).json({ erro: 'Apenas o responsável pode criar laborantins' });
  }

  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ erro: 'Campos obrigatórios' });
    }

    const existing = await Laborantin.findOne({ email });
    if (existing) return res.status(400).json({ erro: 'Email já existe' });

    const passwordHash = await bcrypt.hash(password, saltRounds);
    const laborantin = new Laborantin({
      establishmentId: req.user.establishmentId,
      name,
      email,
      passwordHash,
      role: role || 'laborantin'
    });
    await laborantin.save();

    res.status(201).json({ id: laborantin._id, name, email, role });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor dos Laboratórios rodando na porta ${PORT}`);
});