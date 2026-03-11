// server.js (versão com diagnóstico)
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
// CONEXÃO MONGODB
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
// LOGS DE DIAGNÓSTICO
// ============================================
console.log('📂 Diretório atual:', __dirname);
console.log('📂 Conteúdo do diretório:', fs.readdirSync(__dirname));
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  console.log('📂 Conteúdo da pasta public:', fs.readdirSync(publicPath));
} else {
  console.log('❌ Pasta public NÃO EXISTE em', __dirname);
}

// ============================================
// MODELOS (compartilhados com o ministério)
// ============================================
// ... (mantenha os modelos exatamente como estavam) ...

// ============================================
// MIDDLEWARES
// ============================================
app.use(express.json());
app.use(express.static(publicPath)); // usa o caminho absoluto
app.use('/certificados', express.static(certDir));

// Rota explícita para a raiz com fallback
app.get('/', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  console.log('📁 Tentando servir:', indexPath);
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send(`Arquivo index.html não encontrado em ${publicPath}`);
  }
});

// ... (todo o resto do seu código, incluindo as rotas e a inicialização do servidor) ...

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor dos Laboratórios rodando na porta ${PORT}`);
});