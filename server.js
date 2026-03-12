require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;

// ========== CONNEXION MONGODB ==========
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sns';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Erro MongoDB:', err));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== MODÈLES ==========

// Système de compteur pour garantir l'unicité par labo
const counterSchema = new mongoose.Schema({
  labId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true },
  year: { type: Number, required: true },
  seq: { type: Number, default: 0 }
});
counterSchema.index({ labId: 1, year: 1 }, { unique: true });
const Counter = mongoose.model('Counter', counterSchema);

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

const Certificate = mongoose.model('Certificate', certificateSchema);

// ========== UTILITAIRES ==========

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

// ========== MIDDLEWARE JWT ==========
const authJWT = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Sessão expirada' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
    const lab = await Establishment.findById(decoded.id);
    if (!lab) return res.status(401).json({ erro: 'Lab não encontrado' });
    req.lab = lab;
    next();
  } catch (err) { return res.status(403).json({ erro: 'Token inválido' }); }
};

// ========== API ROUTES ==========

app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    const labs = await Establishment.find({ establishmentType: 'laboratorio' }).select('+keyHash');
    let lab = null;
    for (const est of labs) {
      if (await bcrypt.compare(apiKey, est.keyHash)) { lab = est; break; }
    }
    if (!lab) return res.status(401).json({ erro: 'Chave API inválida' });
    const token = jwt.sign({ id: lab._id }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '7d' });
    res.json({ token, lab: { nome: lab.name } });
  } catch (error) { res.status(500).json({ erro: 'Erro no servidor' }); }
});

app.post('/api/laboratorio/certificados', authJWT, async (req, res) => {
  try {
    const { tipo, paciente, laborantin, dados } = req.body;
    const currentYear = new Date().getFullYear();

    const counter = await Counter.findOneAndUpdate(
      { labId: req.lab._id, year: currentYear },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const labShortId = req.lab._id.toString().slice(-4).toUpperCase();
    const numero = `CERT-${labShortId}-${currentYear}-${counter.seq.toString().padStart(4, '0')}`;
    const idade = paciente.dataNascimento ? calcularIdade(paciente.dataNascimento) : null;
    let imcData = { imc: null, classificacao: null };
    if (dados?.peso && dados?.altura) imcData = calcularIMC(dados.peso, dados.altura);

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
      imcCalculado: imcData.imc,
      classificacaoIMC: imcData.classificacao
    });

    await certificate.save();
    res.json({ success: true, numero, idade, imc: imcData.imc, classificacaoIMC: imcData.classificacao });
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.get('/api/laboratorio/stats', authJWT, async (req, res) => {
    const total = await Certificate.countDocuments({ establishmentId: req.lab._id });
    const porTipo = await Certificate.aggregate([
      { $match: { establishmentId: req.lab._id } },
      { $group: { _id: '$diseaseCategory', count: { $sum: 1 } } }
    ]);
    res.json({ total, porTipo });
});

app.get('/api/laboratorio/certificados', authJWT, async (req, res) => {
    const { paciente } = req.query;
    const query = { establishmentId: req.lab._id };
    if (paciente) query.patientName = { $regex: paciente, $options: 'i' };
    const certs = await Certificate.find(query).sort({ createdAt: -1 });
    res.json(certs);
});

// ========== ROUTES HTML (DESIGN ORIGINAL) ==========

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Login</title><style>body{background:#006633;font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}.box{background:white;padding:30px;border-radius:10px;width:300px;box-shadow:0 5px 15px rgba(0,0,0,0.3);}h2{text-align:center;color:#006633;}input,button{width:100%;padding:12px;margin:8px 0;border-radius:5px;border:1px solid #ddd;}button{background:#006633;color:white;cursor:pointer;font-weight:bold;}</style></head><body><div class="box"><h2>🔬 Laboratório SNS</h2><input type="text" id="apiKey" placeholder="Chave API (LAB-...)" autofocus><button onclick="login()">Entrar</button><p id="erro" style="color:red;"></p></div><script>async function login(){const key=document.getElementById('apiKey').value;const r=await fetch('/api/laboratorio/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})});const d=await r.json();if(r.ok){localStorage.setItem('token',d.token);localStorage.setItem('labNome',d.lab.nome);window.location.href='/dashboard';}else{document.getElementById('erro').innerText=d.erro;}}</script></body></html>`);
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><title>Dashboard</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif;}body{background:#f5f7fa;display:flex;min-height:100vh;}.sidebar{width:260px;background:#006633;color:white;padding:2rem 1rem;}.sidebar a{display:block;padding:1rem;color:white;text-decoration:none;background:rgba(255,255,255,0.1);margin:10px 0;border-radius:8px;}.main{flex:1;padding:2rem;}.card{background:white;padding:1.5rem;border-radius:12px;box-shadow:0 4px 10px rgba(0,0,0,0.05);border-left:6px solid #006633;}table{width:100%;background:white;margin-top:20px;border-collapse:collapse;}th{background:#006633;color:white;padding:12px;}td{padding:12px;border-bottom:1px solid #eee;}</style></head><body><div class="sidebar"><h2>SNS • LAB</h2><a href="#" onclick="mostrar('dashboard')">📊 Dashboard</a><a href="#" onclick="mostrar('certificados')">📜 Certificados</a><a href="/novo-certificado" style="background:#ffaa00;color:#00331a;font-weight:bold;">➕ Novo Certificado</a><a href="/" onclick="localStorage.clear()" style="background:#c0392b;margin-top:20px;">Sair</a></div><div class="main"><h1>Bem-vindo, <span id="labNome"></span></h1><div id="secaoDashboard"><div class="card"><h3>Total de Certificados</h3><div style="font-size:3rem;color:#006633;" id="totalCert">0</div></div></div><div id="secaoCertificados" style="display:none;"><table><thead><tr><th>Nº Certificado</th><th>Paciente</th><th>Tipo</th><th>Data</th></tr></thead><tbody id="tabelaCertificados"></tbody></table></div></div><script>const token=localStorage.getItem('token');if(!token)location.href='/';document.getElementById('labNome').innerText=localStorage.getItem('labNome');function mostrar(s){document.getElementById('secaoDashboard').style.display=s==='dashboard'?'block':'none';document.getElementById('secaoCertificados').style.display=s==='certificados'?'block':'none';if(s==='certificados')carregar();}async function carregar(){const r=await fetch('/api/laboratorio/certificados',{headers:{'Authorization':'Bearer '+token}});const d=await r.json();let h='';d.forEach(c=>{h+='<tr><td>'+c.certificateNumber+'</td><td>'+c.patientName+'</td><td>'+c.diseaseCategory+'</td><td>'+new Date(c.createdAt).toLocaleDateString()+'</td></tr>'});document.getElementById('tabelaCertificados').innerHTML=h;}async function stats(){const r=await fetch('/api/laboratorio/stats',{headers:{'Authorization':'Bearer '+token}});const d=await r.json();document.getElementById('totalCert').innerText=d.total;}stats();</script></body></html>`);
});

app.get('/novo-certificado', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><title>Novo Certificado</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif;}body{background:#f0f4f0;padding:2rem;display:flex;justify-content:center;}.container{max-width:900px;width:100%;background:white;padding:2rem;border-radius:20px;}.header{background:#006633;color:white;padding:1.5rem;border-radius:12px;margin-bottom:20px;}.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}.campo{display:flex;flex-direction:column;margin-bottom:15px;}input,select{padding:10px;border:1px solid #ddd;border-radius:8px;}.btn-emitir{background:#006633;color:white;padding:1.2rem;border-radius:50px;width:100%;border:none;font-size:1.2rem;cursor:pointer;margin-top:20px;}#modalPreview{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:none;justify-content:center;align-items:center;}.modal-content{background:white;padding:2rem;border-radius:20px;max-width:500px;width:90%;}</style></head><body>
<div class="container">
  <div class="header"><h1>➕ Novo Certificado <span>LAB</span></h1></div>
  <form id="certForm">
    <div class="campo"><label>TIPO DE CERTIFICADO *</label>
      <select id="tipo" required>
        <option value="" disabled selected>— Selecione —</option>
        <option value="1">1 - GENÓTIPO</option><option value="2">2 - BOA SAÚDE</option><option value="3">3 - INCAPACIDADE</option><option value="4">4 - APTIDÃO</option>
        <option value="5">5 - SAÚDE MATERNA</option><option value="6">6 - PRÉ-NATAL</option><option value="7">7 - EPIDEMIOLÓGICO</option><option value="8">8 - CSD</option>
      </select>
    </div>
    <div class="grid-2">
      <div class="campo" style="grid-column: span 2;"><label>Nome completo *</label><input type="text" id="nomeCompleto" required></div>
      <div class="campo"><label>BI / Documento</label><input type="text" id="bi"></div>
      <div class="campo"><label>Género</label><select id="genero"><option value="M">Masculino</option><option value="F" selected>Feminino</option></select></div>
      <div class="campo" style="grid-column: span 2;"><label>Data de Nascimento *</label><input type="date" id="dataNasc" required></div>
    </div>
    <div id="camposDinamicos" style="background:#f9f9f9;padding:15px;border-radius:10px;margin-top:10px;"></div>
    <div class="grid-2" style="margin-top:20px;">
      <div class="campo"><label>Técnico Responsável *</label><input type="text" id="tecnico" required></div>
      <div class="campo"><label>Registro</label><input type="text" id="registro"></div>
    </div>
    <button type="submit" class="btn-emitir">📥 Emitir certificado</button>
  </form>
  <div id="resultado" style="display:none;text-align:center;padding:2rem;">
    <h2 style="color:#006633;">✅ Sucesso!</h2>
    <div id="numeroGerado" style="font-size:2rem;background:#ffcc00;margin:1rem;padding:1rem;border-radius:10px;"></div>
    <button onclick="location.reload()" class="btn-emitir">Fazer Outro</button>
  </div>
</div>

<div id="modalPreview"><div class="modal-content"><h2>Confirmar Dados</h2><div id="prevData"></div><button onclick="enviar()" id="btnConfirm" class="btn-emitir">Confirmar e Enviar</button><button onclick="document.getElementById('modalPreview').style.display='none'" style="background:#eee;border:none;padding:10px;width:100%;margin-top:10px;border-radius:50px;cursor:pointer;">Voltar</button></div></div>

<script>
const token=localStorage.getItem('token'); if(!token)location.href='/';
const exames = {
  1: ['genotipo','grupoSanguineo','fatorRh'], 
  2: ['peso','altura','tensao','glicemia'],
  3: ['incapacidade','grau'], 4:['aptidao'], 5:['semanasGesta','dum'], 6:['vidal','hiv','hbs'], 7:['doenca'], 8:['destino','vacina']
};

document.getElementById('tipo').addEventListener('change', function(){
  const lista = exames[this.value] || [];
  let html = '<div class="grid-2">';
  lista.forEach(c => { html += '<div class="campo"><label>'+c.toUpperCase()+'</label><input type="text" id="c_'+c+'" name="'+c+'"></div>'; });
  document.getElementById('camposDinamicos').innerHTML = html + '</div>';
});

document.getElementById('certForm').addEventListener('submit', function(e){
  e.preventDefault();
  document.getElementById('modalPreview').style.display='flex';
  document.getElementById('prevData').innerText = "Paciente: " + document.getElementById('nomeCompleto').value;
});

async function enviar(){
  document.getElementById('btnConfirm').innerText="⏳ Enviando...";
  const tipo = document.getElementById('tipo').value;
  const dadosExtra = {};
  document.querySelectorAll('[id^="c_"]').forEach(el => { if(el.value) dadosExtra[el.name] = el.value; });

  const payload = {
    tipo,
    paciente: { nomeCompleto: document.getElementById('nomeCompleto').value, bi: document.getElementById('bi').value, dataNascimento: document.getElementById('dataNasc').value, genero: document.getElementById('genero').value },
    laborantin: { nome: document.getElementById('tecnico').value },
    dados: dadosExtra
  };

  const r = await fetch('/api/laboratorio/certificados', {
    method: 'POST',
    headers: {'Content-Type':'application/json', 'Authorization':'Bearer '+token},
    body: JSON.stringify(payload)
  });
  const res = await r.json();
  if(r.ok){
    document.getElementById('certForm').style.display='none';
    document.getElementById('modalPreview').style.display='none';
    document.getElementById('resultado').style.display='block';
    document.getElementById('numeroGerado').innerText = res.numero;
  } else { alert("Erro: " + res.erro); }
}
</script></body></html>`);
});

app.listen(PORT, () => console.log(`🚀 Laboratório rodando na porta ${PORT}`));
