/* Uses CSS vars: --color-floating-btn */
export const floatingCSS = `
  #floatingBtn {
    position: fixed; bottom: 15px; right: 45px;
    z-index: 9999; animation: float 3s ease-in-out infinite;
  }
  .floating-btn {
    cursor: pointer; display: flex; align-items: center;
    background: var(--color-floating-btn, #fc0e3f);
    border: 0; border-radius: 9999px;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
    color: #fff; filter: brightness(1.15); font-weight: 500;
    overflow: hidden; padding: 1.25rem;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
`;
