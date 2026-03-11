// server.js (avec logs détaillés)
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

// ============================================
// Modelo Establishment (mesmo do ministério)
// ============================================
const PROVINCIAS = [
  'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango',
  'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla',
  'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico',
  'Namibe', 'Uíge', 'Zaire'
];

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
  keyHash: { type: String, required: true },
  keyPrefix: { type: String, default: 'SNS-' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

establishmentSchema.virtual('status').get(function() {
  if (!this.isActive) return 'Inativo';
  return this.licenseValidity < new Date() ? 'Inativo' : 'Ativo';
});

const Establishment = mongoose.model('Establishment', establishmentSchema);

// ============================================
// Modelo Certificate (mesmo do ministério)
// ============================================
const certificateSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true },
  createdBy: { type: String },
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

// ============================================
// Funções auxiliares
// ============================================
function gerarNumeroCertificado() {
  const ano = new Date().getFullYear();
  const mes = (new Date().getMonth() + 1).toString().padStart(2, '0');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `CERT-${ano}${mes}-${random}`;
}

// Middleware de autenticação por API Key
const authLaboratorio = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ erro: 'API Key não fornecida' });

  const prefix = apiKey.split('-')[0];
  if (prefix !== 'LAB') {
    return res.status(403).json({ erro: 'Chave inválida para laboratório' });
  }

  try {
    const labs = await Establishment.find({ establishmentType: 'laboratorio' });
    let lab = null;
    for (const est of labs) {
      if (await bcrypt.compare(apiKey, est.keyHash)) {
        lab = est;
        break;
      }
    }

    if (!lab) return res.status(401).json({ erro: 'Chave API inválida' });
    if (lab.status === 'Inativo') return res.status(403).json({ erro: 'Laboratório inativo' });

    req.lab = lab;
    next();
  } catch (error) {
    console.error('Erro no auth:', error);
    res.status(500).json({ erro: 'Erro interno' });
  }
};

// ============================================
// Rotas Públicas (HTML embutido)
// ============================================
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Login Laboratório</title>
  <style>
    body{background:#006633;font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
    .box{background:white;padding:30px;border-radius:10px;width:300px;box-shadow:0 5px 15px rgba(0,0,0,0.3);}
    h2{text-align:center;color:#006633;margin-bottom:20px;}
    input,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box;border-radius:5px;border:1px solid #ddd;}
    button{background:#006633;color:white;border:none;font-weight:bold;cursor:pointer;}
    button:hover{background:#004d26;}
    .erro{color:#c00;text-align:center;margin-top:10px;}
  </style>
</head>
<body>
  <div class="box">
    <h2>🔬 Laboratório SNS</h2>
    <input type="text" id="apiKey" placeholder="Chave API (LAB-...)" autofocus>
    <button onclick="login()">Entrar</button>
    <p id="erro" class="erro"></p>
  </div>
  <script>
    async function login() {
      const key = document.getElementById('apiKey').value;
      const erro = document.getElementById('erro');
      if (!key) { erro.innerText = 'Digite a chave API'; return; }
      try {
        const r = await fetch('/api/laboratorio/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        });
        const data = await r.json();
        if (r.ok) {
          localStorage.setItem('token', data.token);
          localStorage.setItem('labNome', data.lab.nome);
          window.location.href = '/dashboard';
        } else {
          erro.innerText = data.erro || 'Erro na autenticação';
        }
      } catch (e) {
        erro.innerText = 'Erro de ligação ao servidor';
      }
    }
  </script>
</body>
</html>
  `);
});

app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Dashboard Laboratório</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f7f6;padding:20px;}
    .header{background:#006633;color:white;padding:15px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;}
    .container{max-width:1200px;margin:0 auto;}
    .card{background:white;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 2px 5px rgba(0,0,0,0.1);}
    table{width:100%;border-collapse:collapse;}
    th{background:#f0f0f0;padding:10px;text-align:left;}
    td{padding:10px;border-bottom:1px solid #eee;}
    button{padding:8px 15px;background:#006633;color:white;border:none;border-radius:5px;cursor:pointer;}
    .logout{background:#c00;}
    .btn-add{background:#006633;margin-top:10px;}
  </style>
</head>
<body>
  <div class="header">
    <h2>🔬 <span id="labNome"></span></h2>
    <button class="logout" onclick="logout()">Sair</button>
  </div>
  <div class="container">
    <div class="card">
      <h3>Certificados Recentes</h3>
      <div id="certificados"></div>
    </div>
    <button class="btn-add" onclick="window.location.href='/novo-certificado'">➕ Novo Certificado</button>
  </div>
  <script>
    const token = localStorage.getItem('token');
    if (!token) window.location.href = '/';
    document.getElementById('labNome').innerText = localStorage.getItem('labNome') || '';

    async function carregarCertificados() {
      try {
        const r = await fetch('/api/laboratorio/certificados', {
          headers: { 'x-api-key': token }
        });
        const certs = await r.json();
        let html = '<table><tr><th>Número</th><th>Paciente</th><th>Data</th><th>Ações</th></tr>';
        if (certs.length === 0) {
          html = '<p>Nenhum certificado emitido.</p>';
        } else {
          certs.forEach(c => {
            html += '<tr>' +
              '<td>' + c.certificateNumber + '</td>' +
              '<td>' + c.patientName + '</td>' +
              '<td>' + new Date(c.createdAt).toLocaleDateString('pt-PT') + '</td>' +
              '<td><button onclick="baixarPDF(\'' + c._id + '\')">📄 PDF</button></td>' +
              '</tr>';
          });
          html += '</table>';
        }
        document.getElementById('certificados').innerHTML = html;
      } catch (e) {
        document.getElementById('certificados').innerHTML = '<p>Erro ao carregar</p>';
      }
    }

    async function baixarPDF(id) {
      try {
        const r = await fetch('/api/laboratorio/certificados/' + id + '/pdf', {
          headers: { 'x-api-key': token }
        });
        if (!r.ok) throw new Error();
        const blob = await r.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'certificado.pdf';
        a.click();
      } catch (e) {
        alert('Erro ao gerar PDF');
      }
    }

    function logout() {
      localStorage.clear();
      window.location.href = '/';
    }

    carregarCertificados();
  </script>
</body>
</html>
  `);
});

app.get('/novo-certificado', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Novo Certificado</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f7f6;padding:20px;}
    .header{background:#006633;color:white;padding:15px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;}
    .container{max-width:800px;margin:0 auto;}
    .card{background:white;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 2px 5px rgba(0,0,0,0.1);}
    .campo{margin-bottom:15px;}
    label{display:block;font-weight:bold;margin-bottom:5px;}
    input,select,textarea{width:100%;padding:10px;border:1px solid #ddd;border-radius:5px;}
    button{padding:12px 20px;background:#006633;color:white;border:none;border-radius:5px;cursor:pointer;font-size:16px;}
    .erro{color:#c00;margin-top:10px;}
  </style>
</head>
<body>
  <div class="header">
    <h2>➕ Novo Certificado</h2>
    <button onclick="window.location.href='/dashboard'">Voltar</button>
  </div>
  <div class="container">
    <div class="card">
      <form id="formCert">
        <h3>Dados do Paciente</h3>
        <div class="campo">
          <label>Nome Completo *</label>
          <input type="text" id="patientName" required>
        </div>
        <div class="campo">
          <label>Documento (BI)</label>
          <input type="text" id="patientId">
        </div>
        <div class="campo">
          <label>Data de Nascimento</label>
          <input type="date" id="patientBirthDate">
        </div>
        <div class="campo">
          <label>Categoria da Doença *</label>
          <select id="diseaseCategory" required>
            <option value="">Selecione</option>
            <option value="Malaria">Malária</option>
            <option value="Tuberculose">Tuberculose</option>
            <option value="COVID-19">COVID-19</option>
            <option value="HIV/SIDA">HIV/SIDA</option>
            <option value="Hepatite">Hepatite</option>
            <option value="Febre Tifoide">Febre Tifoide</option>
            <option value="Outra">Outra</option>
          </select>
        </div>
        <div class="campo">
          <label>Diagnóstico *</label>
          <textarea id="diagnosis" rows="3" required></textarea>
        </div>
        <div class="campo">
          <label>Resultados Detalhados (opcional)</label>
          <textarea id="testResults" rows="2"></textarea>
        </div>
        <div class="campo">
          <button type="submit">Emitir Certificado</button>
        </div>
        <div id="erro" class="erro"></div>
      </form>
    </div>
  </div>
  <script>
    const token = localStorage.getItem('token');
    if (!token) window.location.href = '/';

    document.getElementById('formCert').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dados = {
        patientName: document.getElementById('patientName').value,
        patientId: document.getElementById('patientId').value,
        patientBirthDate: document.getElementById('patientBirthDate').value,
        diseaseCategory: document.getElementById('diseaseCategory').value,
        diagnosis: document.getElementById('diagnosis').value,
        testResults: document.getElementById('testResults').value
      };
      try {
        const r = await fetch('/api/laboratorio/certificados', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': token },
          body: JSON.stringify(dados)
        });
        const data = await r.json();
        if (r.ok) {
          alert('Certificado emitido: ' + data.numero);
          window.location.href = '/dashboard';
        } else {
          document.getElementById('erro').innerText = data.erro || 'Erro';
        }
      } catch (e) {
        document.getElementById('erro').innerText = 'Erro de ligação';
      }
    });
  </script>
</body>
</html>
  `);
});

// ============================================
// API de Login (avec logs détaillés)
// ============================================
app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    console.log('Tentativa de login avec clé:', apiKey);
    if (!apiKey) return res.status(400).json({ erro: 'Chave API não fornecida' });

    const prefix = apiKey.split('-')[0];
    console.log('Préfixe:', prefix);
    if (prefix !== 'LAB') {
      return res.status(403).json({ erro: 'Chave inválida para laboratório' });
    }

    // Récupérer tous les laboratoires
    const labs = await Establishment.find({ establishmentType: 'laboratorio' });
    console.log('Nombre de laboratoires trouvés:', labs.length);

    let lab = null;
    for (const est of labs) {
      console.log('Comparaison avec:', est.name);
      try {
        const match = await bcrypt.compare(apiKey, est.keyHash);
        if (match) {
          lab = est;
          console.log('Correspondance trouvée!');
          break;
        }
      } catch (bcryptError) {
        console.error('Erreur bcrypt pour', est.name, bcryptError);
      }
    }

    if (!lab) {
      console.log('Aucune correspondance');
      return res.status(401).json({ erro: 'Chave API inválida' });
    }

    console.log('Laboratoire trouvé:', lab.name);
    console.log('Statut virtuel:', lab.status);
    if (lab.status === 'Inativo') {
      return res.status(403).json({ erro: 'Laboratório inativo' });
    }

    const token = jwt.sign(
      { id: lab._id, nome: lab.name },
      process.env.JWT_SECRET || 'secret-key',
      { expiresIn: '7d' }
    );

    res.json({ token, lab: { nome: lab.name } });
  } catch (error) {
    console.error('ERREUR DÉTAILLÉE:', error);
    res.status(500).json({ erro: 'Erro interno do servidor', detalhe: error.message });
  }
});

// ============================================
// Rotas Protegidas
// ============================================
app.get('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const certs = await Certificate.find({ establishmentId: req.lab._id }).sort({ createdAt: -1 });
    res.json(certs);
  } catch (error) {
    console.error('Erro ao listar certificados:', error);
    res.status(500).json({ erro: 'Erro ao listar certificados' });
  }
});

app.post('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const { patientName, patientId, patientBirthDate, diseaseCategory, diagnosis, testResults } = req.body;
    if (!patientName || !diseaseCategory || !diagnosis) {
      return res.status(400).json({ erro: 'Campos obrigatórios' });
    }

    const numero = gerarNumeroCertificado();
    const certificate = new Certificate({
      establishmentId: req.lab._id,
      createdBy: 'Laborantin',
      certificateNumber: numero,
      patientName,
      patientId,
      patientBirthDate: patientBirthDate ? new Date(patientBirthDate) : undefined,
      diseaseCategory,
      diagnosis,
      testResults
    });
    await certificate.save();

    res.json({ success: true, numero });
  } catch (error) {
    console.error('Erro ao criar certificado:', error);
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/laboratorio/certificados/:id/pdf', authLaboratorio, async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id);
    if (!certificate) return res.status(404).json({ erro: 'Certificado não encontrado' });
    if (certificate.establishmentId.toString() !== req.lab._id.toString()) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }

    const lab = req.lab;
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${certificate.certificateNumber}.pdf`);
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
    doc.fontSize(14).text(lab.name, 50, y);
    doc.fontSize(10).fillColor('#666').text(`NIF: ${lab.nif} | ${lab.province}`, 50, y + 20);
    doc.text(`Endereço: ${lab.address} | Tel: ${lab.phone1}`, 50, y + 35);
    y += 60;

    // Certificado
    doc.fillColor('#006633').fontSize(12).text(`CERTIFICADO Nº: ${certificate.certificateNumber}`, 50, y);
    doc.fontSize(10).fillColor('#666').text(`Emissão: ${new Date().toLocaleDateString('pt-PT')}`, 50, y + 15);
    y += 40;

    // Paciente
    doc.fillColor('#006633').text('PACIENTE:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificate.patientName}`, 70, y);
    y += 15;
    if (certificate.patientId) {
      doc.text(`Documento: ${certificate.patientId}`, 70, y);
      y += 15;
    }
    if (certificate.patientBirthDate) {
      doc.text(`Nascimento: ${new Date(certificate.patientBirthDate).toLocaleDateString('pt-PT')}`, 70, y);
      y += 15;
    }

    // Diagnóstico
    doc.fillColor('#006633').text('DIAGNÓSTICO:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Categoria: ${certificate.diseaseCategory}`, 70, y);
    y += 15;
    doc.text(`Diagnóstico: ${certificate.diagnosis}`, 70, y);
    y += 15;

    // Resultados
    if (certificate.testResults) {
      doc.fillColor('#006633').text('RESULTADOS:', 50, y);
      y += 20;
      doc.fillColor('#000').fontSize(10).text(certificate.testResults, 70, y);
      y += 15;
    }

    // QR Code
    const qrData = `${certificate.certificateNumber}|${lab.name}|${certificate.patientName}`;
    const qrBuffer = await QRCode.toBuffer(qrData, { width: 100 });
    doc.image(qrBuffer, 450, 650, { width: 100 });

    doc.end();
  } catch (error) {
    console.error('Erro PDF:', error);
    res.status(500).json({ erro: error.message });
  }
});

// ============================================
// Iniciar servidor
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Laboratório rodando na porta ${PORT}`);
});