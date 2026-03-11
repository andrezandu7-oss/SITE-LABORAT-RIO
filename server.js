// server.js - Version complète et optimisée
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
// Connexion MongoDB
// ============================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sns';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Erro MongoDB:', err));

// ============================================
// Middlewares globaux
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // pour servir novo-certificado.html

// ============================================
// Modèles
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

certificateSchema.index({ createdAt: -1 });
certificateSchema.index({ patientName: 'text' }); // pour recherche textuelle

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

// ============================================
// Middleware d'authentification optimisé
// ============================================
const authLaboratorio = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ erro: 'API Key não fornecida' });

  const prefix = apiKey.split('-')[0];
  if (prefix !== 'LAB') return res.status(403).json({ erro: 'Chave inválida para laboratório' });

  try {
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

// server.js (extrait modifié pour inclure /novo-certificado directement)
// ... (le reste du code reste identique)

// Remplacer la route /novo-certificado par une version embarquée
app.get('/novo-certificado', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Novo Certificado - SNS</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Segoe UI',sans-serif; }
    body { background:#f0f4f0; display:flex; justify-content:center; align-items:flex-start; min-height:100vh; padding:2rem 1rem; }
    .container { max-width:950px; width:100%; background:white; border-radius:24px; box-shadow:0 20px 40px rgba(0,40,20,0.15); overflow:hidden; }
    .header { background:#006633; color:white; padding:2rem 2.5rem; }
    .header h1 { font-size:2rem; display:flex; align-items:center; gap:12px; }
    .header h1 span { background:#ffcc00; color:#006633; font-size:1rem; padding:4px 12px; border-radius:40px; }
    .header p { margin-top:6px; }
    .form-card { padding:2.5rem; }
    .section-title { font-size:1.4rem; font-weight:600; color:#006633; border-bottom:2px solid #cce8d5; padding-bottom:0.5rem; margin:2rem 0 1.5rem; }
    .grid-2 { display:grid; grid-template-columns:repeat(2,1fr); gap:1.5rem; }
    .campo { display:flex; flex-direction:column; gap:6px; margin-bottom:0.8rem; }
    .full-width { grid-column:span 2; }
    label { font-weight:600; font-size:0.85rem; text-transform:uppercase; color:#2d4a3b; }
    input, select, textarea { padding:12px 14px; border:1.5px solid #d0ded5; border-radius:14px; font-size:0.95rem; outline:none; }
    input:focus, select:focus { border-color:#006633; box-shadow:0 0 0 3px rgba(0,102,51,0.2); }
    .tipo-selector { background:#f0f8f2; border-radius:20px; padding:1.5rem; margin-bottom:2rem; border-left:6px solid #006633; }
    .btn-emitir { background:#006633; color:white; border:none; font-size:1.2rem; font-weight:700; padding:1.2rem; border-radius:50px; width:100%; cursor:pointer; margin-top:2.5rem; box-shadow:0 8px 16px rgba(0,102,51,0.3); }
    .campos-dinamicos { background:#fafdfb; border-radius:24px; padding:1.8rem 1.5rem; border:1px dashed #99bbaa; }
    .info-message { color:#2c5e3f; background:#e0f0e5; padding:1rem; border-radius:16px; margin-bottom:1.5rem; }
    .resultado-popup { background:white; border-radius:24px; padding:2rem; text-align:center; max-width:450px; margin:2rem auto; }
    .resultado-popup .sucesso { color:#006633; font-size:2rem; font-weight:bold; }
    .resultado-popup .numero { background:#ffcc00; padding:0.5rem 1rem; border-radius:60px; font-family:monospace; font-size:1.4rem; margin:1rem 0; display:inline-block; }
    .hidden { display:none; }
    #modalPreview { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:none; justify-content:center; align-items:center; z-index:1000; padding:20px; }
    .modal-content { background:white; padding:2.5rem; border-radius:24px; max-width:600px; width:100%; max-height:90vh; overflow-y:auto; }
    .preview-item { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #eee; font-size:0.95rem; }
    .preview-item b { color:#006633; }
  </style>
</head>
<body>
<div class="container">
  <div class="header"><h1>➕ Novo Certificado <span>LAB</span></h1><p>Preencha os dados</p></div>
  <div class="form-card">
    <div id="loadingMessage" class="info-message">A validar...</div>
    <form id="certForm" style="display:none;">
      <div class="tipo-selector">
        <label for="tipo">TIPO DE CERTIFICADO *</label>
        <select id="tipo" required>
          <option value="" disabled selected>— Selecione —</option>
          <option value="1">1 - GENÓTIPO</option><option value="2">2 - BOA SAÚDE</option><option value="3">3 - INCAPACIDADE</option>
          <option value="4">4 - APTIDÃO</option><option value="5">5 - SAÚDE MATERNA</option><option value="6">6 - PRÉ-NATAL</option>
          <option value="7">7 - EPIDEMIOLÓGICO</option><option value="8">8 - CSD</option>
        </select>
      </div>
      <div class="section-title">👤 Dados do paciente</div>
      <div class="grid-2">
        <div class="full-width campo"><label>Nome completo *</label><input type="text" id="nomeCompleto" required></div>
        <div class="campo"><label>BI</label><input type="text" id="bi"></div>
        <div class="campo"><label>Nascimento *</label><input type="date" id="dataNascimento" required></div>
        <div class="campo"><label>Género</label><select id="genero"><option value="M">M</option><option value="F" selected>F</option></select></div>
        <div class="full-width campo"><label>Telefone</label><input type="tel" id="telefone"></div>
      </div>
      <div class="section-title">🔬 Responsável</div>
      <div class="grid-2">
        <div class="full-width campo"><label>Nome *</label><input type="text" id="laborantinNome" required></div>
        <div class="campo"><label>Registro</label><input type="text" id="laborantinRegistro"></div>
      </div>
      <div class="section-title">📋 Parâmetros específicos</div>
      <div class="campos-dinamicos" id="camposEspecificosContainer"><p class="info-message">👆 Selecione um tipo para ver os campos.</p></div>
      <button type="submit" class="btn-emitir" id="btnEmitir">📥 Emitir certificado</button>
    </form>
    <div id="resultadoArea" class="hidden"></div>
  </div>
</div>
<div id="modalPreview">
  <div class="modal-content">
    <h2 style="color:#006633;">🔍 Confirmar Dados</h2>
    <div id="previewContent"></div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-top:2rem;">
      <button type="button" onclick="fecharPreview()" style="background:#f0f0f0; padding:1.2rem; border-radius:50px; cursor:pointer;">Modificar</button>
      <button type="button" id="btnConfirmarFinal" style="background:#006633; color:white; padding:1.2rem; border-radius:50px; cursor:pointer; font-weight:700;">Confirmar</button>
    </div>
  </div>
</div>
<script>
const examesPorTipo={1:['grupoSanguineo','fatorRh','genotipo','hemoglobina','hematocrito','contagem_reticulocitos','eletroforese'],2:['peso','altura','pressaoArterial','frequenciaCardiaca','frequenciaRespiratoria','temperatura','saturacaoOxigenio','glicemia','colesterolTotal','triglicerideos'],3:['tipoIncapacidade','causa','grau','dataInicio','partesAfetadas','limitacoes','necessitaAcompanhante'],4:['tipoAptidao','modalidade','resultado','restricoes','validade'],5:['gestacoes','partos','abortos','nascidosVivos','dum','dpp','idadeGestacional','consultasCPN','hemograma','gotaEspessa','hiv','vdrl','hbs','glicemia','creatinina','ureia','tgo','grupoSanguineo','fatorRh','exsudadoVaginal','pesoAtual','alturaUterina','batimentosCardiacosFeto','movimentosFetais','edema','proteinuria'],6:['grupoSanguineo','fatorRh','hemograma','gotaEspessa','hiv','vdrl','hbs','vidal','glicemia','creatinina','ureia','tgo','testeGravidez','exsudadoVaginal','vs','falsiformacao'],7:['doenca','outraDoenca','dataInicioSintomas','dataDiagnostico','metodoDiagnostico','tipoExame','resultado','tratamento','internamento','dataInternamento','contatos'],8:['destino','motivoViagem','dataPartida','dataRetorno','vacinaFebreAmarela','dataVacinaFebreAmarela','loteVacinaFebreAmarela','vacinaCovid19','dosesCovid','testeCovid','tipoTesteCovid','dataTesteCovid','resultadoTesteCovid','outrasVacinas','medicamentos','condicoesEspeciais','recomendacoes']};
const opcoesSelect={'grupoSanguineo':['A','B','AB','O'],'fatorRh':['Positivo (+)','Negativo (-)'],'genotipo':['AA','AS','SS','AC','SC'],'tipoIncapacidade':['Física','Mental','Sensorial','Múltipla'],'grau':['Leve','Moderado','Grave'],'tipoAptidao':['Apto','Inapto','Apto com restrições'],'modalidade':['Desportiva','Laboral','Escolar'],'resultado':['Positivo','Negativo','Inconclusivo'],'metodoDiagnostico':['Clínico','Laboratorial','Imagem'],'tipoExame':['PCR','Antigénio','Sorologia'],'vacinaFebreAmarela':['Sim','Não'],'vacinaCovid19':['Sim','Não'],'testeCovid':['Sim','Não']};
function formatarNomeCampo(chave){return chave.replace(/([A-Z])/g,' $1').replace(/^./,s=>s.toUpperCase());}
const form=document.getElementById('certForm'),tipoSelect=document.getElementById('tipo'),containerCampos=document.getElementById('camposEspecificosContainer'),loading=document.getElementById('loadingMessage'),resultadoArea=document.getElementById('resultadoArea'),modal=document.getElementById('modalPreview'),previewContent=document.getElementById('previewContent'),btnConfirmar=document.getElementById('btnConfirmarFinal'),btnEmitir=document.getElementById('btnEmitir');
const token=localStorage.getItem('token');if(!token){loading.innerText='❌ Sessão expirada';setTimeout(()=>window.location.href='/',2000);}else{loading.style.display='none';form.style.display='block';}
tipoSelect.addEventListener('change',function(){const tipo=parseInt(this.value),lista=examesPorTipo[tipo]||[];let html='<div class="grid-2">';lista.forEach(campo=>{const label=formatarNomeCampo(campo);if(opcoesSelect[campo]){html+=`<div class="campo"><label>${label}</label><select name="${campo}" id="campo_${campo}"><option value="" selected disabled>Selec...</option>`+opcoesSelect[campo].map(opt=>`<option value="${opt}">${opt}</option>`).join('')+'</select></div>';}else{let tipoInput='text';if(campo.includes('data')||['dum','dpp','dataInicio','dataDiagnostico','dataInternamento','dataPartida','dataRetorno','dataVacinaFebreAmarela','dataTesteCovid'].includes(campo))tipoInput='date';if(['peso','altura','gestacoes','partos','abortos','nascidosVivos','dosesCovid','validade','idadeGestacional','consultasCPN','contagem_reticulocitos','hemoglobina','hematocrito','glicemia','colesterolTotal','triglicerideos','frequenciaCardiaca','frequenciaRespiratoria','temperatura','saturacaoOxigenio'].includes(campo))tipoInput='number';html+=`<div class="campo"><label>${label}</label><input type="${tipoInput}" name="${campo}" id="campo_${campo}" placeholder="${label}" step="any"></div>`;}});html+='</div>';containerCampos.innerHTML=html;});
form.addEventListener('submit',function(e){e.preventDefault();let html=`<div style="margin-bottom:15px;"><strong>Paciente:</strong> ${document.getElementById('nomeCompleto').value}</div><div style="border-top:1px solid #eee; padding-top:10px;">`;containerCampos.querySelectorAll('input, select').forEach(i=>{if(i.value)html+=`<div class="preview-item"><span>${formatarNomeCampo(i.name)}</span> <b>${i.value}</b></div>`;});html+='</div>';previewContent.innerHTML=html;modal.style.display='flex';});
window.fecharPreview=()=>{modal.style.display='none';};
btnConfirmar.addEventListener('click',async function(){fecharPreview();btnEmitir.disabled=true;btnEmitir.textContent='⏳ Emitindo...';const tipo=parseInt(tipoSelect.value),payload={tipo,paciente:{nomeCompleto:document.getElementById('nomeCompleto').value,bi:document.getElementById('bi').value,dataNascimento:document.getElementById('dataNascimento').value,genero:document.getElementById('genero').value,telefone:document.getElementById('telefone').value},laborantin:{nome:document.getElementById('laborantinNome').value,registro:document.getElementById('laborantinRegistro').value},dados:{}};(examesPorTipo[tipo]||[]).forEach(campo=>{const el=document.getElementById(`campo_${campo}`);if(el&&el.value.trim()!==''){if(['peso','altura','gestacoes','partos','abortos','nascidosVivos','dosesCovid','idadeGestacional','consultasCPN','hemoglobina','hematocrito','glicemia','colesterolTotal','triglicerideos','frequenciaCardiaca','frequenciaRespiratoria','temperatura','saturacaoOxigenio'].includes(campo)){payload.dados[campo]=parseFloat(el.value.replace(',','.'));}else{payload.dados[campo]=el.value.trim();}}});try{const r=await fetch('/api/laboratorio/certificados',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':token},body:JSON.stringify(payload)});const data=await r.json();if(!r.ok)throw new Error(data.erro||'Erro');form.style.display='none';resultadoArea.innerHTML=`<div class="resultado-popup"><div class="sucesso">✅ Sucesso</div><div class="numero">${data.numero}</div><p><strong>IMC:</strong> ${data.imc||'—'} | ${data.classificacaoIMC||'—'}</p><p><strong>Idade:</strong> ${data.idade||'?'} anos</p><button class="btn-emitir" onclick="location.reload()">➕ Novo</button></div>`;resultadoArea.classList.remove('hidden');}catch(error){alert('Erro: '+error.message);}finally{btnEmitir.disabled=false;btnEmitir.textContent='📥 Emitir certificado';}});
</script>
</body>
</html>`);
});

// ... le reste du code reste inchangé

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard Laboratório - SNS Angola</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Segoe UI', Roboto, sans-serif; }
    body { background:#f5f7fa; display:flex; min-height:100vh; }
    .sidebar { width:260px; background:#006633; color:white; padding:2rem 1rem; display:flex; flex-direction:column; box-shadow: 2px 0 10px rgba(0,0,0,0.1); }
    .sidebar h2 { font-size:1.5rem; margin-bottom:2rem; text-align:center; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:1rem; }
    .sidebar a, .sidebar button { display:block; width:100%; padding:0.8rem 1rem; margin:0.5rem 0; border:none; background:rgba(255,255,255,0.1); color:white; text-align:left; border-radius:8px; cursor:pointer; font-size:1rem; text-decoration:none; transition:0.2s; }
    .sidebar a:hover, .sidebar button:hover { background:rgba(255,255,255,0.2); }
    .sidebar .novo-btn { background:#ffaa00; color:#00331a; font-weight:bold; }
    .sidebar .sair-btn { margin-top:auto; background:#c0392b; }
    .main { flex:1; padding:2rem; overflow-y:auto; }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem; }
    .header h1 { color:#006633; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:1.5rem; margin-bottom:2rem; }
    .card { background:white; border-radius:12px; padding:1.5rem; box-shadow:0 4px 10px rgba(0,0,0,0.05); border-left:6px solid #006633; }
    .card h3 { font-size:1rem; color:#666; margin-bottom:0.5rem; }
    .card .numero { font-size:2.5rem; font-weight:bold; color:#006633; }
    .filtros { display:flex; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .filtros select, .filtros input { padding:0.8rem; border:1px solid #ddd; border-radius:8px; flex:1; }
    table { width:100%; border-collapse:collapse; background:white; border-radius:12px; overflow:hidden; box-shadow:0 4px 10px rgba(0,0,0,0.05); }
    th { background:#006633; color:white; padding:1rem; text-align:left; }
    td { padding:1rem; border-bottom:1px solid #eee; }
    tr:hover { background:#f9f9f9; }
    .btn { background:#006633; color:white; border:none; padding:0.5rem 1rem; border-radius:6px; cursor:pointer; }
    .btn-sm { padding:0.3rem 0.8rem; font-size:0.9rem; }
    .badge { background:#e8f5e9; color:#2e7d32; padding:0.2rem 0.5rem; border-radius:20px; font-size:0.8rem; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2>SNS • LAB</h2>
    <a href="#" onclick="mostrarSecao('dashboard')">📊 Dashboard</a>
    <a href="#" onclick="mostrarSecao('certificados')">📜 Certificados</a>
    <a href="#" class="novo-btn" onclick="window.location.href='/novo-certificado'">➕ Novo Certificado</a>
    <button class="sair-btn" onclick="logout()">🚪 Sair</button>
  </div>
  <div class="main">
    <div class="header">
      <h1>Bem-vindo, <span id="labNome"></span></h1>
      <span id="dataAtual"></span>
    </div>
    <div id="secaoDashboard" style="display:block;">
      <div class="cards">
        <div class="card"><h3>Total de Certificados</h3><div class="numero" id="totalCert">0</div></div>
        <div class="card"><h3>Por Tipo</h3><div id="statsTipo"></div></div>
      </div>
    </div>
    <div id="secaoCertificados" style="display:none;">
      <div class="filtros">
        <select id="filtroTipo">
          <option value="">Todos os tipos</option>
          <option value="1">Genótipo</option><option value="2">Boa Saúde</option><option value="3">Incapacidade</option>
          <option value="4">Aptidão</option><option value="5">Saúde Materna</option><option value="6">Pré-Natal</option>
          <option value="7">Epidemiológico</option><option value="8">CSD</option>
        </select>
        <input type="text" id="buscaPaciente" placeholder="Buscar paciente...">
        <button class="btn" onclick="carregarCertificados()">Filtrar</button>
      </div>
      <table>
        <thead><tr><th>Nº Certificado</th><th>Paciente</th><th>Tipo</th><th>Data</th><th>Ações</th></tr></thead>
        <tbody id="tabelaCertificados"><tr><td colspan="5" style="text-align:center;">Carregando...</td></tr></tbody>
      </table>
    </div>
  </div>
  <script>
    const token = localStorage.getItem('token');
    if (!token) window.location.href = '/';
    document.getElementById('labNome').innerText = localStorage.getItem('labNome') || 'Laboratório';
    document.getElementById('dataAtual').innerText = new Date().toLocaleDateString('pt-PT');
    function mostrarSecao(secao) {
      document.getElementById('secaoDashboard').style.display = secao === 'dashboard' ? 'block' : 'none';
      document.getElementById('secaoCertificados').style.display = secao === 'certificados' ? 'block' : 'none';
      if (secao === 'dashboard') carregarStats();
      if (secao === 'certificados') carregarCertificados();
    }
    async function carregarStats() {
      try {
        const r = await fetch('/api/laboratorio/stats', { headers: { 'x-api-key': token } });
        const data = await r.json();
        document.getElementById('totalCert').innerText = data.total;
        let html = '';
        data.porTipo.forEach(item => { html += \`<div><span class="badge">\${item._id || 'Sem tipo'}</span> \${item.count}</div>\`; });
        document.getElementById('statsTipo').innerHTML = html || '<div>Nenhum dado</div>';
      } catch (e) { console.error(e); }
    }
    async function carregarCertificados() {
      const tipo = document.getElementById('filtroTipo').value;
      const busca = document.getElementById('buscaPaciente').value;
      let url = '/api/laboratorio/certificados';
      const params = new URLSearchParams();
      if (tipo) params.append('tipo', tipo);
      if (busca) params.append('paciente', busca);
      if (params.toString()) url += '?' + params.toString();
      try {
        const r = await fetch(url, { headers: { 'x-api-key': token } });
        const certs = await r.json();
        let html = '';
        if (certs.length === 0) html = '<tr><td colspan="5" style="text-align:center;">Nenhum certificado</td></tr>';
        else {
          certs.forEach(c => {
            html += '<tr><td>' + c.certificateNumber + '</td><td>' + c.patientName + '</td><td>' + (c.diseaseCategory || '—') + '</td><td>' + new Date(c.createdAt).toLocaleDateString('pt-PT') + '</td><td><button class="btn btn-sm" onclick="baixarPDF(\\'' + c._id + '\\')">📄 PDF</button></td></tr>';
          });
        }
        document.getElementById('tabelaCertificados').innerHTML = html;
      } catch (e) { document.getElementById('tabelaCertificados').innerHTML = '<tr><td colspan="5" style="text-align:center;">Erro ao carregar</td></tr>'; }
    }
    async function baixarPDF(id) {
      try {
        const r = await fetch('/api/laboratorio/certificados/' + id + '/pdf', { headers: { 'x-api-key': token } });
        if (!r.ok) throw new Error();
        const blob = await r.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'certificado.pdf';
        a.click();
      } catch (e) { alert('Erro ao gerar PDF'); }
    }
    function logout() { localStorage.clear(); window.location.href = '/'; }
    carregarStats();
  </script>
</body>
</html>`);
});

// La route /novo-certificado sert le fichier public/novo-certificado.html (voir ci-dessous)
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

    const token = jwt.sign({ id: lab._id, nome: lab.name }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '7d' });
    res.json({ token, lab: { nome: lab.name } });
  } catch (error) {
    console.error('Erro login:', error);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

app.get('/api/laboratorio/stats', authLaboratorio, async (req, res) => {
  try {
    const total = await Certificate.countDocuments({ establishmentId: req.lab._id });
    const porTipo = await Certificate.aggregate([
      { $match: { establishmentId: req.lab._id } },
      { $group: { _id: '$diseaseCategory', count: { $sum: 1 } } }
    ]);
    res.json({ total, porTipo });
  } catch (error) {
    console.error('Erro stats:', error);
    res.status(500).json({ erro: 'Erro stats' });
  }
});

app.get('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const { tipo, paciente } = req.query;
    const query = { establishmentId: req.lab._id };
    if (tipo) query.diseaseCategory = `Tipo ${tipo}`;
    if (paciente) query.patientName = { $regex: paciente, $options: 'i' };
    const certs = await Certificate.find(query).sort({ createdAt: -1 }).limit(100);
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

    req.lab.totalEmissoes = (req.lab.totalEmissoes || 0) + 1;
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

// ============================================
// Démarrage du serveur
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Laboratório rodando na porta ${PORT}`);
});