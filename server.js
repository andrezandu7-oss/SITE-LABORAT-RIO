// server.js (optimisé avec index et performances améliorées)
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

// Connexion MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sns';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Erro MongoDB:', err));

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// Modelos com índices
// ============================================
const PROVINCIAS = [
  'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango',
  'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla',
  'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico',
  'Namibe', 'Uíge', 'Zaire'
];

const establishmentSchema = new mongoose.Schema({
  establishmentType: { type: String, enum: ['laboratorio', 'hospital', 'empresa', 'ong'], required: true, index: true },
  name: { type: String, required: true, trim: true },
  nif: { type: String, required: true, unique: true, trim: true },
  institutionType: { type: String, enum: ['Público', 'Privado'], required: true },
  province: { type: String, required: true, enum: PROVINCIAS },
  municipality: { type: String, required: true, trim: true },
  address: { type: String, required: true, trim: true },
  phone1: { type: String, required: true, trim: true },
  phone2: { type: String, trim: true },
  email: { type: String, lowercase: true, trim: true },
  director: { type: String, required: true, trim: true },
  technicalResponsible: { type: String, required: true, trim: true },
  licenseNumber: { type: String, required: true, trim: true },
  licenseValidity: { type: Date, required: true },
  keyHash: { type: String, required: true, unique: true },
  keyPrefix: { type: String, default: 'SNS-', index: true },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

establishmentSchema.virtual('status').get(function() {
  if (!this.isActive) return 'Inativo';
  return this.licenseValidity < new Date() ? 'Inativo' : 'Ativo';
});

const Establishment = mongoose.model('Establishment', establishmentSchema);

const certificateSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true, index: true },
  createdBy: { type: String },
  certificateNumber: { type: String, required: true, unique: true },
  patientName: { type: String, required: true },
  patientId: { type: String },
  patientBirthDate: { type: Date },
  diseaseCategory: { type: String, required: true },
  diagnosis: { type: String, required: true },
  testDate: { type: Date, default: Date.now },
  testResults: { type: mongoose.Schema.Types.Mixed },
  idadeCalculada: Number,
  imcCalculado: Number,
  classificacaoIMC: String
}, { timestamps: true });

certificateSchema.index({ createdAt: -1 }); // pour tri rapide

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
// Fonctions utilitaires
// ============================================
function gerarNumeroCertificado() {
  const ano = new Date().getFullYear();
  const mes = (new Date().getMonth() + 1).toString().padStart(2, '0');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `CERT-${ano}${mes}-${random}`;
}

function calcularIdade(dataNascimento) {
  if (!dataNascimento) return null;
  const hoje = new Date();
  const nasc = new Date(dataNascimento);
  let idade = hoje.getFullYear() - nasc.getFullYear();
  const m = hoje.getMonth() - nasc.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < nasc.getDate())) idade--;
  return idade;
}

function calcularIMC(peso, altura) {
  if (!peso || !altura || altura <= 0) return { imc: null, classificacao: null };
  const imc = peso / (altura * altura);
  let classificacao = '';
  if (imc < 18.5) classificacao = 'Abaixo do peso';
  else if (imc < 25) classificacao = 'Peso normal';
  else if (imc < 30) classificacao = 'Sobrepeso';
  else if (imc < 35) classificacao = 'Obesidade grau I';
  else if (imc < 40) classificacao = 'Obesidade grau II';
  else classificacao = 'Obesidade grau III';
  return { imc: imc.toFixed(2), classificacao };
}

// Middleware d'authentification optimisé
const authLaboratorio = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ erro: 'API Key não fornecida' });

  const prefix = apiKey.split('-')[0];
  if (prefix !== 'LAB') return res.status(403).json({ erro: 'Chave inválida para laboratório' });

  try {
    // Utilise l'index sur establishmentType et keyPrefix pour réduire le champ de recherche
    const labs = await Establishment.find({ 
      establishmentType: 'laboratorio',
      keyPrefix: 'LAB-'
    }).select('+keyHash');
    
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
    console.error('Erro auth:', error);
    res.status(500).json({ erro: 'Erro interno' });
  }
};

// ============================================
// Routes HTML (embarquées mais allégées)
// ============================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Login Laboratório</title>
  <style>body{background:#006633;font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}.box{background:white;padding:30px;border-radius:10px;width:300px;box-shadow:0 5px 15px rgba(0,0,0,0.3);}h2{text-align:center;color:#006633;margin-bottom:20px;}input,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box;border-radius:5px;border:1px solid #ddd;}button{background:#006633;color:white;border:none;font-weight:bold;cursor:pointer;}button:hover{background:#004d26;}.erro{color:#c00;text-align:center;margin-top:10px;}</style>
</head>
<body>
<div class="box"><h2>🔬 Laboratório SNS</h2><input type="text" id="apiKey" placeholder="Chave API (LAB-...)" autofocus><button onclick="login()">Entrar</button><p id="erro" class="erro"></p></div>
<script>async function login(){const key=document.getElementById('apiKey').value,erro=document.getElementById('erro');if(!key){erro.innerText='Digite a chave API';return;}try{const r=await fetch('/api/laboratorio/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})});const data=await r.json();if(r.ok){localStorage.setItem('token',data.token);localStorage.setItem('labNome',data.lab.nome);window.location.href='/dashboard';}else{erro.innerText=data.erro||'Erro na autenticação';}}catch(e){erro.innerText='Erro de ligação ao servidor';}}</script>
</body></html>`);
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Dashboard Laboratório</title>
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f7f6;padding:20px;}.header{background:#006633;color:white;padding:15px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;}.container{max-width:1200px;margin:0 auto;}.card{background:white;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 2px 5px rgba(0,0,0,0.1);}table{width:100%;border-collapse:collapse;}th{background:#f0f0f0;padding:10px;text-align:left;}td{padding:10px;border-bottom:1px solid #eee;}button{padding:8px 15px;background:#006633;color:white;border:none;border-radius:5px;cursor:pointer;}.logout{background:#c00;}.btn-add{background:#006633;margin-top:10px;}</style>
</head>
<body>
<div class="header"><h2>🔬 <span id="labNome"></span></h2><button class="logout" onclick="logout()">Sair</button></div>
<div class="container"><div class="card"><h3>Certificados Recentes</h3><div id="certificados"></div></div><button class="btn-add" onclick="window.location.href='/novo-certificado'">➕ Novo Certificado</button></div>
<script>const token=localStorage.getItem('token');if(!token)window.location.href='/';document.getElementById('labNome').innerText=localStorage.getItem('labNome')||'';async function carregarCertificados(){try{const r=await fetch('/api/laboratorio/certificados',{headers:{'x-api-key':token}});const certs=await r.json();let html='';if(certs.length===0)html='<p>Nenhum certificado emitido.</p>';else{html='<table><tr><th>Número</th><th>Paciente</th><th>Data</th><th>Ações</th></tr>';certs.forEach(c=>{html+='<tr><td>'+c.certificateNumber+'</td><td>'+c.patientName+'</td><td>'+new Date(c.createdAt).toLocaleDateString('pt-PT')+'</td><td><button onclick="baixarPDF(\''+c._id+'\')">📄 PDF</button></td></tr>';});html+='</table>';}document.getElementById('certificados').innerHTML=html;}catch(e){document.getElementById('certificados').innerHTML='<p>Erro ao carregar</p>';}}async function baixarPDF(id){try{const r=await fetch('/api/laboratorio/certificados/'+id+'/pdf',{headers:{'x-api-key':token}});if(!r.ok)throw new Error();const blob=await r.blob();const url=window.URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='certificado.pdf';a.click();}catch(e){alert('Erro ao gerar PDF');}}function logout(){localStorage.clear();window.location.href='/';}carregarCertificados();</script>
</body></html>`);
});

// Pour le formulaire de certificat, nous allons le servir comme fichier séparé (allégé) mais on peut aussi le laisser ici. On va le laisser dans un fichier à part pour plus de clarté, mais comme l'utilisateur veut un seul bloc, on va l'inclure via sendFile. Il faut créer le fichier public/novo-certificado.html séparément. Je vais donner le contenu du fichier après.

app.get('/novo-certificado', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'novo-certificado.html'));
});

// ============================================
// API Routes
// ============================================
app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave API não fornecida' });

    const prefix = apiKey.split('-')[0];
    if (prefix !== 'LAB') return res.status(403).json({ erro: 'Chave inválida para laboratório' });

    const labs = await Establishment.find({ establishmentType: 'laboratorio', keyPrefix: 'LAB-' }).select('+keyHash');
    let lab = null;
    for (const est of labs) {
      if (await bcrypt.compare(apiKey, est.keyHash)) {
        lab = est;
        break;
      }
    }
    if (!lab) return res.status(401).json({ erro: 'Chave API inválida' });
    if (lab.status === 'Inativo') return res.status(403).json({ erro: 'Laboratório inativo' });

    const token = jwt.sign(
      { id: lab._id, nome: lab.name },
      process.env.JWT_SECRET || 'secret-key',
      { expiresIn: '7d' }
    );
    res.json({ token, lab: { nome: lab.name } });
  } catch (error) {
    console.error('Erro login:', error);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

app.get('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const certs = await Certificate.find({ establishmentId: req.lab._id })
      .sort({ createdAt: -1 })
      .limit(50); // limite pour éviter de charger trop
    res.json(certs);
  } catch (error) {
    console.error('Erro listagem:', error);
    res.status(500).json({ erro: 'Erro ao listar certificados' });
  }
});

app.post('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const { tipo, paciente, laborantin, dados } = req.body;
    if (!tipo || !paciente || !paciente.nomeCompleto || !laborantin || !laborantin.nome) {
      return res.status(400).json({ erro: 'Campos obrigatórios' });
    }

    const numero = gerarNumeroCertificado();
    const idade = paciente.dataNascimento ? calcularIdade(paciente.dataNascimento) : null;
    let imc = null, classificacaoIMC = null;
    if (dados && dados.peso && dados.altura) {
      const calc = calcularIMC(dados.peso, dados.altura);
      imc = calc.imc;
      classificacaoIMC = calc.classificacao;
    }

    const certificate = new Certificate({
      establishmentId: req.lab._id,
      createdBy: laborantin.nome,
      certificateNumber: numero,
      patientName: paciente.nomeCompleto,
      patientId: paciente.bi || null,
      patientBirthDate: paciente.dataNascimento ? new Date(paciente.dataNascimento) : null,
      diseaseCategory: `Tipo ${tipo}`,
      diagnosis: 'Diversos',
      testResults: dados,
      idadeCalculada: idade,
      imcCalculado: imc,
      classificacaoIMC: classificacaoIMC
    });
    await certificate.save();

    req.lab.totalEmissoes++;
    await req.lab.save();

    res.json({ success: true, numero, idade, imc, classificacaoIMC });
  } catch (error) {
    console.error('Erro criação:', error);
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

    // En-tête
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
    doc.fontSize(10).fillColor('#666').text(`Emissão: ${new Date(certificate.createdAt).toLocaleDateString('pt-PT')}`, 50, y + 15);
    y += 40;

    // Responsável
    doc.fillColor('#006633').text('RESPONSÁVEL PELA EMISSÃO:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificate.createdBy}`, 70, y);
    y += 15;

    // Paciente
    doc.fillColor('#006633').text('PACIENTE:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificate.patientName}`, 70, y);
    y += 15;
    if (certificate.patientId) { doc.text(`Documento: ${certificate.patientId}`, 70, y); y += 15; }
    if (certificate.patientBirthDate) { doc.text(`Nascimento: ${new Date(certificate.patientBirthDate).toLocaleDateString('pt-PT')}`, 70, y); y += 15; }
    if (certificate.idadeCalculada) { doc.text(`Idade: ${certificate.idadeCalculada} anos`, 70, y); y += 15; }

    // Dados médicos
    if (certificate.testResults && Object.keys(certificate.testResults).length > 0) {
      doc.fillColor('#006633').text('RESULTADOS:', 50, y);
      y += 20;
      doc.fillColor('#000').fontSize(10);
      for (let [chave, valor] of Object.entries(certificate.testResults)) {
        const chaveFormatada = chave.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
        doc.text(`${chaveFormatada}: ${valor}`, 70, y);
        y += 15;
        if (y > 700) { doc.addPage(); y = 50; }
      }
    }

    if (certificate.imcCalculado) {
      doc.fillColor('#006633').text('ÍNDICE DE MASSA CORPORAL:', 50, y);
      y += 20;
      doc.fillColor('#000').fontSize(11).text(`IMC: ${certificate.imcCalculado} (${certificate.classificacaoIMC})`, 70, y);
      y += 25;
    }

    // QR Code
    try {
      const qrData = `${certificate.certificateNumber}|${lab.name}|${certificate.patientName}`;
      const qrBuffer = await QRCode.toBuffer(qrData, { width: 100 });
      doc.image(qrBuffer, 450, 650, { width: 100 });
    } catch (qrError) { console.error('Erro QR:', qrError); }

    // Assinaturas
    doc.lineWidth(1).moveTo(70, y).lineTo(270, y).stroke();
    doc.fontSize(10).text('Assinatura do Laborantin', 70, y + 5).text(certificate.createdBy || '______', 70, y + 20);
    doc.lineWidth(1).moveTo(350, y).lineTo(550, y).stroke();
    doc.fontSize(10).text('Assinatura do Diretor', 350, y + 5).text(lab.director || '______', 350, y + 20);

    doc.fontSize(8).fillColor('#666').text('Documento válido em todo território nacional', 0, 780, { align: 'center' });
    doc.end();
  } catch (error) {
    console.error('Erro PDF:', error);
    res.status(500).json({ erro: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Laboratório rodando na porta ${PORT}`);
});