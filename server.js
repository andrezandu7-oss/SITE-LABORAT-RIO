// server.js
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
const fs = require('fs');

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
// Modelos
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
    .header{background:#006633;color:white;padding:15px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;}
    .container{max-width:1200px;margin:20px auto;}
    .card{background:white;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 2px 5px rgba(0,0,0,0.1);}
    table{width:100%;border-collapse:collapse;}
    th{background:#f0f0f0;padding:10px;text-align:left;}
    td{padding:10px;border-bottom:1px solid #eee;}
    button{padding:8px 15px;background:#006633;color:white;border:none;border-radius:5px;cursor:pointer;}
    .logout{background:#c00;}
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
    <button onclick="window.location.href='/novo-certificado'">➕ Novo Certificado</button>
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
        certs.forEach(c => {
          html += '<tr>' +
            '<td>' + c.numero + '</td>' +
            '<td>' + c.paciente.nomeCompleto + '</td>' +
            '<td>' + new Date(c.emitidoEm).toLocaleDateString('pt-PT') + '</td>' +
            '<td><button onclick="baixarPDF(\'' + c.numero + '\')">📄 PDF</button></td>' +
            '</tr>';
        });
        html += '</table>';
        document.getElementById('certificados').innerHTML = html;
      } catch (e) {
        document.getElementById('certificados').innerHTML = '<p>Erro ao carregar</p>';
      }
    }

    async function baixarPDF(numero) {
      try {
        const r = await fetch('/api/laboratorio/certificados/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': token },
          body: JSON.stringify({ numero })
        });
        if (!r.ok) throw new Error();
        const blob = await r.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = numero + '.pdf';
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
    .header{background:#006633;color:white;padding:15px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;}
    .container{max-width:800px;margin:20px auto;}
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
          <input type="text" id="nomePaciente" required>
        </div>
        <div class="campo">
          <label>Gênero</label>
          <select id="genero">
            <option value="">Selecione</option>
            <option value="M">Masculino</option>
            <option value="F">Feminino</option>
          </select>
        </div>
        <div class="campo">
          <label>Data Nascimento</label>
          <input type="date" id="dataNascimento">
        </div>
        <div class="campo">
          <label>BI</label>
          <input type="text" id="bi">
        </div>
        <h3>Tipo de Certificado</h3>
        <div class="campo">
          <select id="tipo">
            <option value="1">Genótipo</option>
            <option value="2">Boa Saúde</option>
            <option value="3">Incapacidade</option>
            <option value="4">Aptidão</option>
            <option value="5">Saúde Materna</option>
            <option value="6">Pré-Natal</option>
            <option value="7">Epidemiológico</option>
            <option value="8">CSD</option>
          </select>
        </div>
        <h3>Resultados (opcional)</h3>
        <div id="camposResultados"></div>
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

    // Campos padrão para qualquer tipo (simplificado)
    const camposHtml = \`
      <div class="campo">
        <label>Resultado 1</label>
        <input type="text" name="campo1" placeholder="Digite um valor">
      </div>
      <div class="campo">
        <label>Resultado 2</label>
        <input type="text" name="campo2" placeholder="Digite um valor">
      </div>
    \`;
    document.getElementById('camposResultados').innerHTML = camposHtml;

    document.getElementById('formCert').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dados = {
        tipo: parseInt(document.getElementById('tipo').value),
        paciente: {
          nomeCompleto: document.getElementById('nomePaciente').value,
          genero: document.getElementById('genero').value,
          dataNascimento: document.getElementById('dataNascimento').value,
          bi: document.getElementById('bi').value
        },
        laborantin: { nome: 'Laborantin' },
        dados: {
          campo1: document.querySelector('[name="campo1"]').value,
          campo2: document.querySelector('[name="campo2"]').value
        }
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
// Rotas Protegidas (com authLaboratorio)
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